/**
 * Voice Agent Provider Interface
 *
 * SPEC-09: Provider-agnostic adapter pattern for Voice AI.
 * This interface ensures the core NexDrive business logic remains decoupled
 * from the specific voice provider (Retell, Vapi, Bland).
 */

export interface CallStatus {
    callId: string;
    status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed';
    customerPhone: string;
}

export interface CallEndedEvent {
    callId: string;
    callerPhone: string;
    startedAt: Date;
    endedAt: Date;
    durationSeconds: number;
    transcript: string;
    summary: string;
    endReason: 'caller_hangup' | 'assistant_hangup' | 'timeout' | 'error' | string;
    recordingUrl?: string;
}

export interface FunctionCallRequest {
    callId: string;
    functionName: string;
    parameters: Record<string, any>;
    callerPhone?: string;
}

export interface FunctionCallResponse {
    result: string;  // Natural language result for the assistant to speak
    data?: Record<string, any>;  // Structured data (optional, for assistant context)
}

export interface VoiceAgentProvider {
    /** Provider identifier (e.g., 'retell', 'vapi') */
    readonly providerId: string;

    /**
     * Parse the incoming webhook from the provider into a standard FunctionCallRequest.
     */
    parseFunctionCallRequest(rawRequest: Record<string, any>): FunctionCallRequest | null;

    /**
     * Format our internal function-call response into the provider's expected JSON format.
     */
    formatFunctionCallResponse(response: FunctionCallResponse): Record<string, any>;

    /**
     * Parse an end-of-call webhook into a standard CallEndedEvent for our database.
     */
    parseCallEndedEvent(rawEvent: Record<string, any>): CallEndedEvent | null;
}
