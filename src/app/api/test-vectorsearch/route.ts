// src/app/api/test-vectorsearch/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  Firestore,
  VectorQuery,
  VectorQuerySnapshot
} from "@google-cloud/firestore";
import { EmbeddingService } from '@/app/api/indexing/embedding';

// // Initialize Firestore with vector search capabilities
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  //   keyFilename: process.env.GCP_KEY_FILE
});

const chunksCollection = db.collection('chunks');
const embeddingService = new EmbeddingService();

interface SearchRequest {
  query: string;
  limit?: number;
  threshold?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SearchRequest;

    if (!body.query) {
      return NextResponse.json({
        success: false,
        error: 'Query text is required'
      }, { status: 400 });
    }

    
    // Generate embedding for the query text
    console.log("NL Query running through vectsearch: " + body.query)
    
    // TODO: Implement Query Embedding
    const queryEmbeddings = 
await embeddingService.getEmbeddings([body.query])

    const queryVector = queryEmbeddings[0];
    
    
    // Configure vector search query  
    // TODO: Implement nearest neighbor search
    const vectorQuery: VectorQuery = chunksCollection.findNearest({
      queryVector,
      vectorField: 'embedding',
      limit: body.limit || 10,
      distanceMeasure: 'EUCLIDEAN'
    });


    // Execute search
    const vectorQuerySnapshot: VectorQuerySnapshot = await vectorQuery.get();

    // Process results
    const results = vectorQuerySnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        documentId: data.documentId,
        content: data.content,
        metadata: data.metadata,
        score: data.score
      };
    });

    console.log('query results: ' + results.length + ' results: ' + results)

    // Filter results by threshold if specified
    const filteredResults = body.threshold
      ? results.filter(result => result.score <= body.threshold!)
      : results;

    return NextResponse.json({
      success: true,
      results: filteredResults,
      total: filteredResults.length,
      query: body.query
    });

  } catch (error) {
    console.error('Vector search error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error in vector search'
    }, { status: 500 });
  }
}

// Test endpoint to verify Firestore vector search is properly configured
export async function GET() {
  try {
    // Test query with a simple vector
    const testVector = Array(768).fill(0).map(() => Math.random()); // Match your embedding dimension

    const vectorQuery: VectorQuery = chunksCollection.findNearest({
      queryVector: testVector,
      vectorField: 'embedding',
      limit: 10,
      distanceMeasure: 'EUCLIDEAN'
    });

    const snapshot: VectorQuerySnapshot = await vectorQuery.get();

    // console.log('print results ' + snapshot.docs.length)
    // snapshot.forEach((doc) => {
    //   // console.log(doc.id, ' Distance: ', doc.get('vector_distance'));
    // });

    // Process results
    const results = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        documentId: data.documentId,
        content: data.content,
        metadata: data.metadata,
        score: data.score
      };
    });

    return NextResponse.json({
      success: true,
      message: 'Vector search is properly configured',
      results: results,
      embeddingDimension: testVector.length
    });

  } catch (error) {
    console.error('Vector search configuration test failed:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Vector search configuration test failed',
      hint: 'Ensure Firestore vector search is enabled and properly configured'
    }, { status: 500 });
  }
}