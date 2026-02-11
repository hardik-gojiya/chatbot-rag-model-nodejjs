export function chunkText(text, maxChars = 500, overlapChars = 100) {
  if (typeof text !== "string" || !text.trim()) return [];

  // Normalize text
  const cleanText = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();

  const paragraphs = cleanText
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    // If paragraph itself is too big, split by sentences
    if (para.length > maxChars) {
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxChars) {
          chunks.push(currentChunk.trim());
          currentChunk = sentence;
        } else {
          currentChunk += " " + sentence;
        }
      }
      continue;
    }

    if ((currentChunk + "\n\n" + para).length > maxChars) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Add overlap
  if (overlapChars > 0 && chunks.length > 1) {
    const overlappedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        overlappedChunks.push(chunks[i]);
        continue;
      }
      const prev = chunks[i - 1];
      const overlap = prev.slice(-overlapChars);
      overlappedChunks.push(overlap + "\n\n" + chunks[i]);
    }
    return overlappedChunks;
  }

  return chunks;
}
