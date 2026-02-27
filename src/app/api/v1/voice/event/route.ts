import { NextResponse } from 'next/server';
import { getVoiceProvider } from '@/lib/voice';

/**
 * POST /api/v1/voice/event
 * 
 * Handles End-Of-Call Events.
 * When Retell hangs up, it sends the full transcript, duration, and summary here.
 * We must save this to the `call_logs` table (per SPEC-09).
 */
export async function POST(request: Request) {
    const provider = getVoiceProvider();

    try {
        const payload = await request.json();

        // Use the provider-agnostic parser we built
        const callEvent = provider.parseCallEndedEvent(payload);

        if (!callEvent) {
            console.log(`Ignored non-end event from ${provider.providerId}.`);
            return NextResponse.json({ status: 'ignored' });
        }

        console.log(`[Voice] Call ${callEvent.callId} ended. Duration: ${callEvent.durationSeconds}s. Summary: ${callEvent.summary}`);

        // TODO: Write to Drizzle Database (call_logs table) here.
        // Example: await db.insert(schema.callLogs).values({...callEvent})

        return NextResponse.json({ status: 'success', message: 'Call log saved.' });

    } catch (error) {
        console.error(`[Voice] Error parsing ${provider.providerId} event webhook:`, error);
        return NextResponse.json(
            { error: 'Failed to process event webhook.' },
            { status: 500 }
        );
    }
}
