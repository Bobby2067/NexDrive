import { VoiceAgentProvider } from './provider.interface';
import { RetellAdapter } from './retell.adapter';

/**
 * Access the configured voice provider adapter.
 * According to SPEC-09, building for replacement.
 */
export function getVoiceProvider(): VoiceAgentProvider {
    // We explicitly switch this to Retell based on the active API Key
    return new RetellAdapter();
}
