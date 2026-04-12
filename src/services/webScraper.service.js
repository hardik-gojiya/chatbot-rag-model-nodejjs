import {
  PlaywrightCrawler,
  Dataset,
  RequestQueue,
  Configuration,
} from "crawlee";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parsePDFfromURL } from "./parsePDFfromURL.service.js";

export const webScraperService = async (url) => {
  const requestId = uuidv4();
  const tempDir = path.join(os.tmpdir(), `rag-scraper-${requestId}`);

  // Create a configuration that uses a temporary directory
  const config = new Configuration({
    storageDir: tempDir,
  });

  const storageClient = config.getStorageClient();

  let requestQueue;
  let dataset;

  function isPDF(url) {
    return url.toLowerCase().endsWith(".pdf");
  }

  function extractLinks() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    return anchors
      .map((a) => {
        try {
          return new URL(a.href, location.href).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  try {
    requestQueue = await RequestQueue.open(requestId, { storageClient });
    dataset = await Dataset.open(requestId, { storageClient });

    const crawler = new PlaywrightCrawler(
      {
        requestQueue,
        maxConcurrency: 1,
        maxRequestsPerCrawl: 10,
        requestHandlerTimeoutSecs: 30,

        async requestHandler({ request, page, enqueueLinks, log }) {
          log.info(`Scraping: ${request.url}`);

          if (isPDF(request.url)) {
            log.info(`Skipping PDF file: ${request.url}`);
            const pdfData = await parsePDFfromURL(request.url);

            if (pdfData.error) {
              log.error(`PDF parse error: ${request.url} - ${pdfData.error}`);
              return;
            }

            await dataset.pushData({
              title: path.basename(request.url, ".pdf"),
              url: request.loadedUrl,
              text: pdfData.text,
            });

            return;
          }

          await page.waitForLoadState("networkidle");

          const title = await page.title();

          const plainText = await page.evaluate(() => {
            const selector = "script, style, noscript";
            const elements = document.querySelectorAll(selector);
            elements.forEach((el) => el.remove());

            return document.body.innerText.replace(/\s\s+/g, " ").trim();
          });

          if (plainText) {
            await dataset.pushData({
              title,
              url: request.loadedUrl,
              text: plainText,
            });
          } else {
            log.warning(`Skipping empty page: ${request.loadedUrl}`);
          }

          await enqueueLinks({ strategy: "same-domain" });
        },
      },
      config,
    );

    await crawler.run([url]);
    const { items } = await dataset.getData();
    return { items, pageCount: items.length };
  } catch (error) {
    console.log("Scraping error:", error);
    return null;
  } finally {
    try {
      if (dataset) await dataset.drop();
      if (requestQueue) await requestQueue.drop();

      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Cleanup error:", e);
    }
  }
};
