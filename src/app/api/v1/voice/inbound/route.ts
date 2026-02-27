import { NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';

/**
 * POST /api/v1/voice/inbound
 * 
 * Specifically configured for Retell AI Custom LLM Webhook
 * Retell hits this endpoint when the call begins to get the initial system prompt and tools.
 */
export async function POST(request: Request) {
    try {
        const provider = getVoiceProvider();
        const payload = await request.json();

        // Log the interaction for debugging
        console.log(`[${provider.providerId}] Inbound webhook received for call:`, payload?.call_id);

        // According to Retell docs, for a Custom LLM setup we must respond to the 
        // `call_details` interaction with the initial system prompt.
        if (payload.interaction_type === 'call_details' || payload.interaction_type === 'ping') {

            return NextResponse.json({
                response_id: 1, // Required by certain Retell webhook types
                content: "G'day! Thanks for calling NexDrive Academy. My name is NexDrive Assistant. How can I help you get on the road today?",
                content_complete: true,
                // We can dynamically add our Booking Engine tools here later
                // tools: [...] 
            });
        }

        // If it's just a health check or ping from Retell
        return NextResponse.json({ status: 'ignored', reason: 'unhandled_interaction_type' });

    } catch (error) {
        console.error('Error in Voice Inbound Webhook:', error);
        return NextResponse.json(
            { error: 'Internal server error processing voice webhook.' },
            { status: 500 }
        );
    }
}
