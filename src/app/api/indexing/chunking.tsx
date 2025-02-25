// src/app/api/indexing/chunking.ts

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";


export interface ChunkingConfig {
  maxChunkSize: number;
  overlapSize: number;
  minChunkSize?: number;
}

export class DocumentChunker {
  
  private splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  })

  async chunkText(text: string): Promise<string[]> {
    
    if (!text || typeof text !== 'string') {
      return [];
    }

    const outputDocuments = await this.splitter.createDocuments([text]);
    return outputDocuments.map(d => d.pageContent);
  }

}