// src/app/api/indexing/embedding.ts
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import { google } from '@google-cloud/aiplatform/build/protos/protos';

const aiplatform = require('@google-cloud/aiplatform');


export interface EmbeddingConfig {
  maxBatchSize: number;
  modelId: string;
  location: string;
  dimensionality: number;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  maxBatchSize: 5, 
  modelId: "text-embedding-005", 
  location: process.env.GCP_REGION || 'europe-west1',
  dimensionality: 768
};


export class EmbeddingService {
  private client: PredictionServiceClient = aiplatform.v1;
  private endpoint: string;

  constructor(
    private projectId: string = process.env.GCP_PROJECT_ID!,
    private config: EmbeddingConfig = DEFAULT_CONFIG
  ) {
    this.client = new PredictionServiceClient({
      apiEndpoint: `${this.config.location}-aiplatform.googleapis.com`
    });

    this.endpoint = `projects/${this.projectId}/locations/${this.config.location}/publishers/google/models/${this.config.modelId}`;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    // Process in batches due to API limits
    for (let i = 0; i < texts.length; i += this.config.maxBatchSize) {
      const batch = texts.slice(i, i + this.config.maxBatchSize);
      const batchEmbeddings = await this.processTextBatch(batch);
      embeddings.push(...batchEmbeddings);
    }

    

    return embeddings;
  }

  private async processTextBatch(texts: string[]): Promise<number[][]> {
    try {
      // Convert texts to instances format
      const instances = texts.map(text => helpers.toValue({ content: text }));

      // Make prediction request
      const [response] = await this.client.predict({
        endpoint: this.endpoint,
        instances: instances as google.protobuf.Value[],
        parameters: helpers.toValue({})
      });

      if (!response.predictions) {
        throw new Error('No predictions returned from the API');
      }

      // Extract embeddings from response
      return response.predictions.map(prediction => {
        const values = prediction?.structValue?.fields?.embeddings
          ?.structValue?.fields?.values?.listValue?.values;

        if (!values) {
          throw new Error('Invalid embedding response structure');
        }

        return values.map(v => Number(v.numberValue));
      });

    } catch (error) {
      console.error('Error generating embeddings:', error);
      throw new Error(`Embedding generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}