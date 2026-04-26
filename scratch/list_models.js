import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

async function listModels() {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  try {
    const result = await ai.models.list();
    // In the new SDK, it's an iterator or has a models property?
    // Let's check the result keys
    console.log("Result keys:", Object.keys(result));
    
    // Based on previous output, it seems to have models directly or in a property?
    // Wait, the previous output showed a JSON with a "models" array.
    
    // If it's an iterator:
    const models = [];
    for await (const model of result) {
      models.push(model.name);
    }
    console.log("Model names:", models.filter(name => name.includes("flash")));
  } catch (error) {
    console.error("Error listing models:", error);
    // Try another way if it failed
    try {
        const result = await ai.models.list();
        console.log("Direct Result:", JSON.stringify(result).substring(0, 500));
    } catch(e) {}
  }
}

listModels();
