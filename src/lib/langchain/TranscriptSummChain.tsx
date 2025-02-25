import { RunnableSequence } from "@langchain/core/runnables";
import { StructuredOutputParser } from "langchain/output_parsers";
import { createGeminiTextModel, PROMPT_TEMPLATES } from "./config";
import { VectorSearchUtil } from '@/lib/Firebase/VectorSearch';
import { z } from "zod";
import { CallbackHandler } from "langfuse-langchain";

// Initialize Langfuse callback handler
const langfuseHandler = new CallbackHandler({
  publicKey: process.env.LF_PUBLIC_KEY,
  secretKey: process.env.LF_SECRET_KEY,
  baseUrl: "https://cloud.langfuse.com"
});

// Types for structured output
interface Task {
  description: string;
}

// Enhanced research result interface with source documentation
interface ResearchResult {
  task: string;
  answer: string;
  steps: string[];
  caveats: string[];
  docReferences: Array<{
    title: string;
    url: string;
    relevantContent?: string; // Optional excerpt of relevant content
    citedIn: Array<'answer' | 'steps' | 'caveats'>; // Track where this source is used
  }>;
}

interface DocumentChunk {
  content: string;
  url: string;
  title?: string;
}

// Task Extraction Chain
export const createTaskExtractionChain = () => {
  const taskParser = StructuredOutputParser.fromZodSchema(z.array(z.object({
    description: z.string(),
  })));

  const model = createGeminiTextModel(0.1);

  // TODO: Define Runnable Sequence for task extraction
  return RunnableSequence.from([
    {
      transcript: (input: any) => input.transcript,
      format_instructions: () => taskParser.getFormatInstructions(),
    },
    PROMPT_TEMPLATES.taskExtraction,
    model,
    taskParser,
  ]);


};

// Research Chain for a single task
export const createResearchChain = () => {
  // Enhanced research parser that includes source citations
  const researchParser = StructuredOutputParser.fromZodSchema(z.object({
    answer: z.string(),
    steps: z.array(z.string()),
    caveats: z.array(z.string()),
    docReferences: z.array(z.object({
      title: z.string(),
      url: z.string(),
      relevantContent: z.string().optional(),
      citedIn: z.array(z.enum(['answer', 'steps', 'caveats'])),
    })),
  }));

  const vectorSearch = new VectorSearchUtil();
  const model = createGeminiTextModel(1.0);

  // Format document chunks with source information
  const formatDocumentContext = (chunks: DocumentChunk[]): string => {
    return chunks.map((chunk, index) => {
      const title = chunk.title || 'GCP Documentation';
      return `
SOURCE [${index + 1}]: ${title}
URL [${index + 1}]: ${chunk.url}
CONTENT [${index + 1}]:
${chunk.content}
---
`;
    }).join('\n');
  };

  return async (task: Task): Promise<ResearchResult> => {
    try {
      console.log('Searching resources for:', task.description);
      const searchResponse = await vectorSearch.performSearch(
        task.description,
        {
          limit: 5,
          threshold: 0.6
        }
      );

      if (searchResponse.error) {
        throw new Error(`Vector search failed: ${searchResponse.error}`);
      }

      console.log('Found resources for task:', task.description, 'Number of relevant documents:', searchResponse.results.length);

      // Format search results into DocumentChunks with URLs
      const documentChunks: DocumentChunk[] = searchResponse.results.map(result => ({
        content: result.content,
        url: result.url,
        title: result.metadata?.title
      }));

      // Create formatted context with source information and numbered references
      const formattedContext = formatDocumentContext(documentChunks);

      // Process through research chain
      const chain = RunnableSequence.from([
        {
          task: (input: any) => input.task,
          context: (input: any) => input.context,
          format_instructions: () => researchParser.getFormatInstructions(),
          // sources: (input: any) => input.sources,
        },
        PROMPT_TEMPLATES.research,
        model,
        researchParser,
      ]);

      const result = await chain.invoke({
        task: task.description,
        context: formattedContext,
        // sources: documentChunks.map((chunk, index) => ({
        //   id: index + 1,
        //   title: chunk.title || 'GCP Documentation',
        //   url: chunk.url,
        // })),
      },
        { callbacks: [langfuseHandler] }
      );

      // Combine LLM results with search results to create final research result
      const enhancedResult: ResearchResult = {
        ...result,
        task: task.description,
        docReferences: result.docReferences.map(ref => {
          // Find the corresponding search result
          const sourceDoc = documentChunks.find(chunk =>
            chunk.url === ref.url || chunk.title === ref.title
          );

          return {
            ...ref,
            url: sourceDoc?.url || ref.url, // Prioritize URL from search results
            title: sourceDoc?.title || ref.title,
            relevantContent: sourceDoc?.content,
          };
        }),
      };

      return enhancedResult;

    } catch (error) {
      console.error(`Research chain failed for task: ${task.description}`, error);
      return {
        task: task.description,
        answer: 'Failed to research this task due to technical issues.',
        steps: [],
        caveats: ['Research process encountered an error.'],
        docReferences: [],
      };
    }
  };
};

// Email Generation Chain
export const createEmailChain = () => {
  const model = createGeminiTextModel(1.0);
  const emailPrompt = PROMPT_TEMPLATES.emailGeneration;

  return RunnableSequence.from([
    {
      tasks: (input: any) => input.tasks,
      research: (input: any) => input.research,
      docLinks: (input: any) => input.docLinks,
    },
    emailPrompt,
    model,
  ]);
};

// Main processing function
export async function processTranscript(transcript: string) {
  try {
    console.log("Processing transcript chain with input...");

    // 1. Extract tasks
    const taskChain = createTaskExtractionChain();
    // TODO: Add missing chain parameter
    const tasks = await taskChain.invoke({
      transcript: transcript,
    },
      { callbacks: [langfuseHandler] }
    );

    console.log('Extracted tasks:', tasks);

    // 2. Research each task individually
    const researchChain = createResearchChain();
    const researchPromises = tasks.map(task =>
      researchChain(task).catch(error => {
        console.error(`Failed to research task: ${task.description}`, error);
        return {
          task: task.description,
          answer: "Failed to research this task.",
          steps: [],
          caveats: ["Research failed for this task."],
          docReferences: [],
        };
      })
    );

    const researchResults = await Promise.all(researchPromises);
    console.log('Research completed:', researchResults);

    // 3. Generate email using all research results
    // TODO: Create and Invoke correct generation chain
    const emailChain = createEmailChain()
    const email = await emailChain.invoke({
      tasks: JSON.stringify(tasks, null, 2),
      research: JSON.stringify(researchResults, null, 2),
      docLinks: researchResults
        .flatMap(r => r.docReferences)
        .map(ref => `- ${ref.title}: ${ref.url}`)
        .join("\n"),
    },
      { callbacks: [langfuseHandler] }
    );

    console.log("Email generated:", email);

    return {
      tasks,
      research: researchResults,
      email: email.content,
    };

  } catch (error) {
    console.error("Error in transcript processing:", error);
    throw error;
  }
}