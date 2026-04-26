import fs from "fs";
import axios from "axios";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import logger from "./logger.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

export const processFile = async (filepath, mimeType) => {
  let content = "";
  let isTempFile = false;
  let localPath = filepath;

  try {
    // If filepath is a URL, download it first
    if (filepath.startsWith("http")) {
      logger.info(`Downloading file from: ${filepath}`);
      const response = await axios.get(filepath, {
        responseType: "arraybuffer",
      });
      const tempPath = path.join(os.tmpdir(), `rag-upload-${uuidv4()}`);
      await fs.promises.writeFile(tempPath, response.data);
      localPath = tempPath;
      isTempFile = true;
    }

    if (!fs.existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }

    logger.info(`Extracting text from ${mimeType} file...`);

    switch (mimeType) {
      case "application/pdf": {
        const dataBuffer = await fs.promises.readFile(localPath);
        const result = await pdf(dataBuffer);
        content = result.text;
        break;
      }

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        const result = await mammoth.extractRawText({ path: localPath });
        content = result.value;
        break;
      }

      case "text/plain":
        content = await fs.promises.readFile(localPath, "utf-8");
        break;

      case "text/csv":
      case "application/vnd.ms-excel":
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
        const workbook = xlsx.readFile(localPath);
        let text = "";
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          text += xlsx.utils.sheet_to_txt(sheet) + "\n";
        });
        content = text;
        break;
      }

      default:
        throw new Error(`Unsupported file type: ${mimeType}`);
    }

    return content;
  } catch (error) {
    logger.error(`File processing error: ${error.message}`);
    throw error;
  } finally {
    // Clean up temp file if we created one
    if (isTempFile && fs.existsSync(localPath)) {
      try {
        await fs.promises.unlink(localPath);
      } catch (err) {
        logger.warn(`Failed to cleanup temp file ${localPath}: ${err.message}`);
      }
    }
  }
};
