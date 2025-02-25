import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerativeModel, GenerationConfig } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';

interface GeminiConfig {
    apiKey: string;
    model?: string;
}

interface GenerationOptions extends Partial<GenerationConfig> {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    responseSchema?: object;
    maxRetries?: number;
    retryDelay?: number;
}

export class GeminiService {
    private genAI: GoogleGenerativeAI;
    private fileManager: GoogleAIFileManager;
    private model: string;
    private defaultGenerationConfig: GenerationConfig = {
        maxOutputTokens: 8192,
        temperature: 0.2,
        topP: 0.95,
    };

    constructor(config: GeminiConfig) {
        if (!config.apiKey) {
            throw new Error('Gemini API Key is required for initialization');
        }

        try {
            this.genAI = new GoogleGenerativeAI(config.apiKey);
            this.fileManager = new GoogleAIFileManager(config.apiKey);
            this.model = config.model || 'gemini-1.5-pro';
        } catch (error) {
            console.error('Failed to initialize Gemini:', error);
            throw new Error(
                `Failed to initialize Gemini client. Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    private getModel(options?: GenerationOptions): GenerativeModel {
        const generationConfig = {
            ...this.defaultGenerationConfig,
            ...options,
        };

        return this.genAI.getGenerativeModel({
            model: this.model,
            generationConfig,
        });
    }

    async uploadFile(path: string, mimeType: string) {
        try {
            const uploadResult = await this.fileManager.uploadFile(path, {
                mimeType,
                displayName: path,
            });

            await this.waitForFileActive(uploadResult.file);
            return uploadResult;
        } catch (error) {
            console.error('Error uploading file:', error);
            throw error;
        }
    }

    private async waitForFileActive(file: any) {
        let currentFile = await this.fileManager.getFile(file.name);
        while (currentFile.state === 'PROCESSING') {
            await new Promise(resolve => setTimeout(resolve, 10000));
            currentFile = await this.fileManager.getFile(file.name);
        }

        if (currentFile.state !== 'ACTIVE') {
            throw new Error(`File ${file.name} failed to process`);
        }
    }

    private cleanJsonResponse(response: string): string {
        try {
            // Remove markdown code block syntax
            let cleaned = response;

            // Remove opening code block
            const codeBlockMatch = cleaned.match(/^```(?:json)?\s*/);
            if (codeBlockMatch) {
                cleaned = cleaned.substring(codeBlockMatch[0].length);
            }

            // Remove closing code block
            cleaned = cleaned.replace(/\s*```\s*$/, '');

            // Remove any additional backtick blocks that might appear
            cleaned = cleaned.replace(/```[\s\S]*?```/g, '');

            // Trim any remaining whitespace
            cleaned = cleaned.trim();

            // Test if it's valid JSON before returning
            JSON.parse(cleaned); // This will throw if invalid

            return cleaned;
        } catch (error) {
            console.error('Error during JSON cleaning:', error);
            // If cleaning fails, try parsing the original response directly
            try {
                JSON.parse(response);
                return response;
            } catch {
                throw new Error('Could not extract valid JSON from response');
            }
        }
    }

    async generateContent(prompt: string, options?: GenerationOptions): Promise<string> {
        try {
            const model = this.getModel(options);

            // TODO: Gemini Content Generation
            const result = await model.generateContent(prompt);

            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Error in Gemini content generation:', error);
            throw error instanceof Error ? error : new Error('Failed to generate content');
        }
    }

    async generateWithRetry(
        prompt: string,
        options?: GenerationOptions
    ): Promise<string> {
        const maxRetries = options?.maxRetries ?? 10;
        const baseDelay = options?.retryDelay ?? 5000;
        const maxDelay = 30000;
        let lastError: Error | undefined;

        // Logistic function parameters
        const k = 1;  // Steepness of the curve
        const midpoint = 7;  // Point of maximum growth

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt >= maxRetries - 3) {
                    // Increase temperature for last few attempts to prevent recitation
                    const increasedTempOptions = {
                        ...options,
                        temperature: 1.8
                    };
                    return await this.generateContent(prompt, increasedTempOptions);
                }
                return await this.generateContent(prompt, options);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');
                console.warn(`Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
                
                // const exponentialDelay = retryDelay * Math.pow(2, attempt - 1);

                if (attempt < maxRetries) {
                    // Calculate logistic backoff
                    const x = attempt - midpoint;
                    const logisticValue = 1 / (1 + Math.exp(-k * x));
                    const delay = Math.min(
                        baseDelay + (maxDelay - baseDelay) * logisticValue,
                        maxDelay
                    );
                    
                    console.debug(`Retry delay: ${Math.round(delay)}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
    }

    async generateStructuredContent<T>(
        prompt: string,
        options?: GenerationOptions
    ): Promise<T> {
        try {
            const model = this.getModel({
                ...options,
                responseMimeType: 'application/json',
            });

            const result = await model.generateContent(prompt);
            const response = await result.response;
            return JSON.parse(response.text()) as T;
        } catch (error) {
            console.error('Error generating structured content:', error);
            throw new Error('Failed to generate structured content');
        }
    }

    async generateStructuredDocumentContent<T>(
        fileRef: any,
        prompt: string,
        mimeType: string = 'application/pdf',
        options?: GenerationOptions,
    ): Promise<T> {
        const generationOptions: GenerationOptions = {
            ...options,
        };

        const jsonString = await this.generateFileContent(
            fileRef,
            prompt,
            mimeType,
            generationOptions
        );
        console.log('Raw document content response:', jsonString);

        try {
            // With schema validation, we might not need cleaning
            const response = generationOptions.responseSchema ? jsonString : this.cleanJsonResponse(jsonString);
            return JSON.parse(response) as T;
        } catch (error) {
            console.error('Error parsing JSON response:', error);
            console.error('Failed JSON string:', jsonString);
            throw new Error('Failed to parse structured document content');
        }
    }

    async generateFileContent(
        fileRef: any,
        prompt: string,
        mimeType: string = 'application/pdf',
        options?: GenerationOptions
    ): Promise<string> {
        try {
            const model = this.getModel(options);

            // console.log("In generate function: ", prompt, mimeType, fileRef)
    
            const result = await model.generateContent([
                {
                    fileData: {
                        fileUri: fileRef.file.uri,
                        mimeType: fileRef.file.mimeType,
                    }
                },
                { text: prompt }
            ]);
    
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Error generating file content:', error);
            throw error instanceof Error ? error : new Error('Failed to generate file content');
        }
    }
}

// Create and export singleton instance
function createGeminiService(modelId?: string): GeminiService {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is required');
    }

    const config: GeminiConfig = {
        apiKey,
        model: modelId || 'gemini-1.5-flash-8b',
    };

    try {
        return new GeminiService(config);
    } catch (error) {
        console.error('Failed to create GeminiService:', error);
        throw error;
    }
}

let geminiServiceInstance: GeminiService;

export function initializeGeminiService(modelId?: string) {
    try {
        geminiServiceInstance = createGeminiService(modelId);
        return geminiServiceInstance;
    } catch (error) {
        console.error('Fatal: Failed to initialize GeminiService:', error);
        throw error;
    }
}

// Initialize with default model
try {
    geminiServiceInstance = createGeminiService();
} catch (error) {
    console.error('Fatal: Failed to initialize GeminiService:', error);
    throw error;
}

export const geminiService = geminiServiceInstance;