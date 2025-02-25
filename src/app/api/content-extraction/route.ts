import { NextRequest, NextResponse } from 'next/server';
import { DocumentScraper } from '../indexing/scraping';
import { initializeGeminiService } from '@/lib/google-ai-studio/gemini';
import { PromptTemplate } from "@langchain/core/prompts";

const docScraper = new DocumentScraper();

// Create extraction prompt template

// TODO: Write html extraction prompt template
const extractionPrompt = PromptTemplate.fromTemplate(`
You are a world class expert in HTML content extraction.
You are tasked with extracting information from HTML content based on a provided entity description.
Your goal is to extract the most relevant information that matches the entity description.
You will be provided with the entity description and the HTML content.
You must return only the extracted information in a JSON format.
Do not include any additional text or explanations.
Do not include any markdown formatting.
If no relevant information is found, return an empty JSON object.

Entity Description: {entityDescription}

HTML Content:
{htmlContent}
`);


export async function POST(request: NextRequest) {
  try {
    const { urls, entityDescription } = await request.json();
    console.log("Content Extraction for: ", urls, entityDescription)

    const geminiService = initializeGeminiService("gemini-2.0-flash");

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({
        error: 'Valid URLs array is required'
      }, { status: 400 });
    }

    if (!entityDescription) {
      return NextResponse.json({
        error: 'Entity description is required'
      }, { status: 400 });
    }

    const results = await Promise.all(urls.map(async (url) => {
      try {
        // Scrape the URL
        const scrapedContent = await docScraper.scrapeUrl(url);

        // console.log("Scraped Content (" , url ,"): ", scrapedContent)

        // Format the prompt
        const formattedPrompt = await extractionPrompt.format({
          entityDescription,
          htmlContent: scrapedContent.rawHTML,
        });

        // Get structured response from Gemini
        const extractionResult = await geminiService.generateWithRetry(formattedPrompt);

        console.log('Extraction Result:', extractionResult);

        return {
          url,
          status: 'success',
          data: extractionResult,
        };

      } catch (error) {
        console.error(`Error processing URL ${url}:`, error);
        return {
          url,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to process URL'
        };
      }
    }));

    return NextResponse.json({
      success: true,
      results
    });

  } catch (error) {
    console.error('Content extraction error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to extract content',
      status: 'error'
    }, { status: 500 });
  }
}