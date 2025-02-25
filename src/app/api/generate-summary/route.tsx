// app/api/generate-summary/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { PromptTemplate } from "@langchain/core/prompts";
import { geminiService } from '@/lib/google-ai-studio/gemini';
import { Langfuse } from "langfuse";

const langfuse = new Langfuse({ 
  publicKey: process.env.LF_PUBLIC_KEY,
  secretKey: process.env.LF_SECRET_KEY,
  baseUrl: "https://cloud.langfuse.com"});

// Create the RAG-aware summary prompt template

// TODO: Implement the search result summary prompt template including required variables
const summaryPrompt = PromptTemplate.fromTemplate(`
You are a helpful assistant that summarizes search results based on a user's question.
You will be provided with a question and a set of search results.
Your task is to summarize the search results in a way that answers the question.
If the search results do not contain any relevant information, you should say that you cannot answer the question.
If the search results contain relevant information, you should summarize the information in a way that answers the question.
You should not include any information that is not in the search results.
You should not include any information that is not relevant to the question.
You should not include any information that is not in the context.

context is here: 
{context}

question is here: 
{question}
`);

interface SearchResult {
  content: string;
  metadata?: {
    title?: string;
    section?: string;
  };
  score: number;
}

export async function POST(request: NextRequest) {
  try {
    const { query, context } = await request.json();

    const trace = langfuse.trace({
      name: "search-triggered",
    });

    if (!query) {
      return NextResponse.json({
        error: 'Query is required'
      }, { status: 400 });
    }

    if (!context || !Array.isArray(context)) {
      return NextResponse.json({
        error: 'Valid context array is required'
      }, { status: 400 });
    }

    // Format the context from search results
    const formattedContext = context
      .sort((a, b) => a.score - b.score) // Sort by relevance
      .map((result: SearchResult) => {
        const title = result.metadata?.title ? `Title: ${result.metadata.title}\n` : '';
        const section = result.metadata?.section ? `Section: ${result.metadata.section}\n` : '';
        return `${title}${section}Content: ${result.content}\n---\n`;
      })
      .join('\n');

    // TODO: Select the correct prompt parameter input
    const formattedPrompt = await summaryPrompt.format({
      question: query,
      context: context,
    });
    
    // Start Langfuse Generation Tracking
    const generation = trace.generation({
      name: "search-summary",
      input: formattedPrompt,
    });

    // Call the model
    const result = await geminiService.generateContent(formattedPrompt);


    generation.end({
      output: result,
    });

    return NextResponse.json({ 
      summary: result,
      status: 'success' 
    });

  } catch (error) {
    console.error('Summary generation error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to generate summary',
      status: 'error',
      details: process.env.NODE_ENV === 'development' ? {
        errorType: error instanceof Error ? error.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
      } : undefined
    }, { status: 500 });
  }
}