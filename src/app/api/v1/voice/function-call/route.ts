import { NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';

/**
 * POST /api/v1/voice/function-call
 * 
 * Invoked mid-call when the Retell AI decides it needs to use a tool 
 * (e.g. "let me check Rob's availability for that date").
 */
export async function POST(request: Request) {
    const provider = getVoiceProvider();

    try {
        const payload = await request.json();

        // Abstract the Retell-specific webhook JSON into our standard request type
        const funcRequest = provider.parseFunctionCallRequest(payload);

        if (!funcRequest) {
            console.error(`[Voice] Could not parse function request from ${provider.providerId}. Payload:`, payload);
            return NextResponse.json({ error: 'Invalid function call request' }, { status: 400 });
        }

        console.log(`[Voice] Executing Tool: ${funcRequest.functionName}`);
        let resultText = "I'm having trouble looking that up right now.";

        // Switch on the standard NexDrive function tool names
        // Later we'll extract these into dedicated files in `src/lib/voice/functions/`
        switch (funcRequest.functionName) {

            case 'check_availability':
                // Example logic:
                // const dateParam = funcRequest.parameters['date'];
                // const slots = await checkInstructorAvailability(instructorId, dateParam);
                console.log("Checking availability for", funcRequest.parameters);
                resultText = "Sure, Rob is available on that date at 10 AM and 2 PM.";
                break;

            case 'query_nexdrive_knowledge':
                // The RAG integration with Gemini and Neon pgvector goes here
                console.log("Querying RAG for", funcRequest.parameters);
                resultText = "According to the ACT Government guidelines, you need a minimum of 7 lessons.";
                break;

            default:
                console.warn(`[Voice] Unknown function called: ${funcRequest.functionName}`);
                resultText = `Sorry, I don't know how to perform the action ${funcRequest.functionName}.`;
        }

        // Wrap our exact string back into the unique JSON format Retell expects
        const finalResponse = provider.formatFunctionCallResponse({
            result: resultText,
            data: { functionName: funcRequest.functionName } // Optional, for debugging
        });

        return NextResponse.json(finalResponse);

    } catch (error) {
        console.error(`[Voice] Error executing function for ${provider.providerId}:`, error);
        return NextResponse.json(
            { error: 'Function execution failed' },
            { status: 500 }
        );
    }
}
