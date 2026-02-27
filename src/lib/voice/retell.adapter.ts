import {
    VoiceAgentProvider,
    FunctionCallRequest,
    FunctionCallResponse,
    CallEndedEvent
} from './provider.interface';

/**
 * Retell AI Adapter Implementation
 * Maps Retell Custom LLM webhooks to NexDrive logic.
 * 
 * Specifically configured for 'Custom LLM' mode where Retell handles 
 * the Voice, but we handle the responses (via Gemini).
 */
export class RetellAdapter implements VoiceAgentProvider {
    readonly providerId = 'retell';

    /**
     * Retell sends a function call (Custom Tool) request inside their interaction payload.
     * Example Retell Webhook for function call:
     * {
     *   "interaction_type": "call_details",
     *   "call_id": "call_123",
     *   "type": "custom_llm",
     *   "custom_llm_request": {
     *      "tool_calls": [{
     *         "name": "check_availability",
     *         "arguments": "{\"date\":\"2026-03-01\"}"
     *      }]
     *   }
     * }
     */
    parseFunctionCallRequest(rawRequest: Record<string, any>): FunctionCallRequest | null {
        try {
            // Custom extraction based on exact Retell webhook structure
            const callArgs = rawRequest?.custom_analysis_data?.tool_calls?.[0] ||
                rawRequest?.tool_calls?.[0]; // Fallback for differing webhook types

            if (!callArgs || !callArgs.name) return null;

            // Retell usually sends arguments as a JSON string
            const parsedArgs = typeof callArgs.arguments === 'string'
                ? JSON.parse(callArgs.arguments)
                : callArgs.arguments;

            return {
                callId: rawRequest.call_id || 'unknown_call_id',
                functionName: callArgs.name,
                parameters: parsedArgs || {},
                // Customer phone is not always in the tool call payload, usually retrieved from init state
                callerPhone: rawRequest?.from_number,
            };
        } catch (error) {
            console.error('[RetellAdapter] Error parsing function call request:', error);
            return null;
        }
    }

    /**
     * Format the response exactly as Retell expects it to speak it aloud
     * Retell Custom Tools expect a specific response structure:
     * {
     *   "tool_responses": [{
     *      "result": "Rob is available at 10am"
     *   }]
     * }
     */
    formatFunctionCallResponse(response: FunctionCallResponse): Record<string, any> {
        return {
            tool_responses: [
                {
                    name: response.data?.functionName || 'unknown',
                    content: response.result,
                }
            ]
        };
    }

    /**
     * Parse the 'call_ended' webhook event from Retell
     * Retell sends a massive JSON block with transcript, duration, and analysis.
     */
    parseCallEndedEvent(rawEvent: Record<string, any>): CallEndedEvent | null {
        if (rawEvent.event !== 'call_ended') return null;

        const callData = rawEvent.call || {};

        return {
            callId: callData.call_id,
            callerPhone: callData.from_number,
            startedAt: new Date(callData.start_timestamp),
            endedAt: new Date(callData.end_timestamp),
            durationSeconds: Math.round((callData.end_timestamp - callData.start_timestamp) / 1000),
            transcript: callData.transcript || '',
            summary: callData.custom_analysis_data?.summary || 'No summary generated.',
            endReason: callData.disconnection_reason || 'unknown',
            recordingUrl: callData.recording_url,
        };
    }
}
