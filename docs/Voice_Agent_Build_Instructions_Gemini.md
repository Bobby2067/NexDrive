# Voice Agent Build Instructions (Gemini Version)
**NexDrive Academy — Phase 2: Never Miss a Lead**
**Target:** Vapi.ai + Google Gemini 2.5 Flash + Neon Postgres (pgvector)

This document provides the step-by-step instructions for a developer to construct the Voice Agent for NexDrive Academy, specifically utilizing Google Gemini as the core inference engine to minimize voice latency and maximize context window capabilities.

---

## 1. Prerequisites & Account Setup

Before writing any code, you need the following services provisioned:

1. **Vapi.ai Account:** Create an account at [vapi.ai](https://vapi.ai). This service handles the telephony (giving you a phone number), Speech-to-Text (transcribing the caller), and Text-to-Speech (speaking the AI's response).
2. **Google AI Studio (Gemini):** Get an API key from Google AI Studio. Ensure you have access to `gemini-2.5-flash` or `gemini-1.5-flash`.
3. **Neon Database:** Access to the `nexdrive-academy` Neon database branch where the `pgvector` extension and your tables (`contacts`, `call_logs`, `availability_rules`, etc.) reside.
4. **Twilio Account (Optional but recommended):** If you want to port an existing Australian 04XX mobile number or local 02 prefix number into Vapi, you will route it through Twilio.

---

## 2. Environment Variables configuration

Add the following to your NexDrive Next.js `.env.local` file:

```env
# -----------------------------------------------------------------------------
# VOICE AGENT & AI (GEMINI)
# -----------------------------------------------------------------------------
GOOGLE_GENAI_API_KEY="AIzaSy..."          # From Google AI Studio
VAPI_API_KEY="your_vapi_api_key"          # From Vapi dashboard (to update assistant config)
VAPI_WEBHOOK_SECRET="your_shared_secret"  # To verify inbound webhooks from Vapi

# Existing DB vars required for RAG and Booking
DATABASE_URL="postgres://user:pass@ep-restless-bird...neon.tech/neondb"
```

---

## 3. Creating the Next.js API Routes (The Webhooks)

Vapi works by sending HTTP POST requests (webhooks) to your custom server. Your Next.js app needs to expose these endpoints.

### Setup the Folder Structure
```text
src/app/api/v1/voice/
├── inbound/route.ts        # Fired when a call starts (returns initial setup)
├── function-call/route.ts  # Fired when Vapi needs data (e.g., check availability)
└── event/route.ts          # Fired continuously (transcripts) and when call ends
```

### Implementing `POST /api/v1/voice/inbound`
When a caller dials the NexDrive number, Vapi hits this endpoint *before* picking up the phone.

**What your code must do:**
1. Verify the `VAPI_WEBHOOK_SECRET`.
2. Extract the caller's phone number (`req.message.call.customer.number`).
3. Look up the caller in the `contacts` or `students` table.
4. Return a JSON configuration telling Vapi to use **Gemini** and giving it the initial prompt.

**Example Response Payload:**
```json
{
  "assistant": {
    "name": "NexDrive Assistant",
    "voice": {
      "provider": "playht",
      "voiceId": "australian_male_friendly" 
    },
    "model": {
      "provider": "google",
      "model": "gemini-2.5-flash",
      "messages": [
        {
          "role": "system",
          "content": "You are the AI assistant for NexDrive Academy in Canberra. The caller's name is John (a current student). Keep responses under 2 sentences. Be friendly and use Australian English."
        }
      ],
      "tools": [
        {
          "type": "function",
          "function": {
            "name": "check_availability",
            "description": "Check if Rob has lesson slots available for a given date.",
            "parameters": {
              "type": "object",
              "properties": {
                "date": { "type": "string", "format": "date" }
              }
            }
          }
        },
        {
           "type": "function",
           "function": {
              "name": "query_nexdrive_knowledge",
              "description": "Fetch information about ACT road rules, pricing, or CBT&A competencies."
           }
        }
      ]
    }
  }
}
```
*Note: Vapi natively supports routing directly to Google's Gemini models.*

---

## 4. Building the Custom Function Tool Handlers

When Gemini decides it needs to use a tool (e.g., the user asked "What does a 90 minute lesson cost?", Gemini triggers `query_nexdrive_knowledge`), Vapi will pause the call and send a POST to `/api/v1/voice/function-call`.

### Implementing `POST /api/v1/voice/function-call`

**What your code must do:**
1. Parse the incoming request: `req.message.functionCall.name`.
2. Switch statement based on the function name.
3. **If `query_nexdrive_knowledge`:**
   - Use the `@google/genai` (or Langchain) SDK to hit your Neon database `pgvector` store based on the user's question.
   - Return the text summary back to Vapi.
4. **If `check_availability`:**
   - Query the Drizzle ORM `availability_rules` and `bookings` tables to find open slots.
   - Return the available times in a conversational string (e.g., "Rob is free on Tuesday at 10am and 2pm.")

**CRITICAL LATENCY RULE:** This endpoint must respond in **under 2000ms** (preferably under 800ms). If deploying to Vercel, ensure this route uses the `edge` runtime or is aggressively kept warm to prevent cold-start pauses on the phone.

---

## 5. Building the RAG Pipeline (Gemini Core)

Because Gemini has a massive context window (1M+ tokens), you have two architectural choices for the `query_nexdrive_knowledge` tool:

**Option A (Standard Vector RAG):**
Extract the user's query, embed it using OpenAI or Google embeddings, query Neon `pgvector`, retrieve the top 3 chunks, and send them back to Vapi.

**Option B (Gemini Context Caching - Recommended for Speed):**
Because your total business knowledge (CBT&A rules, pricing, Rob's policies) is likely under 500,000 tokens, you can utilize Gemini's **Context Caching API**. 
- You upload the entire NexDrive training manual to Gemini once.
- You configure Vapi to use that specific Cached Model ID.
- Gemini instantly knows *everything* about the business without ever needing to trigger the `query_nexdrive_knowledge` webhook at all. 
- *This will significantly reduce voice latency and is highly recommended when using Gemini 1.5/2.5 Pro/Flash.*

---

## 6. Managing the Call Event & CRM Updates

When the caller hangs up, Vapi sends a final payload to `POST /api/v1/voice/event`.

**What your code must do:**
1. Catch the `end-of-call-report` event.
2. Extract the `transcript` and the `summary` generated by Vapi.
3. Insert a new record into your Drizzle `call_logs` table.
4. If the caller was a new prospect (unrecognized number), insert a new record into the `contacts` table (CRM) and optionally send Rob an SMS notification via Twilio ("New prospect called and asked about pricing: [Summary]").

---

## 7. Testing Flow

1. **Local Tunnel:** Use `ngrok` or `localtunnel` to expose your local Next.js `localhost:3000` to the internet.
2. **Vapi Dashboard:** Paste the ngrok URLs into your Vapi Server URL settings.
3. **Call your Vapi Number:** Have a real conversation.
4. **Verify Database:** Check your Neon database to ensure the `call_logs` table populated correctly, and your `contacts` table caught your phone number.
