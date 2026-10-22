# ChatSpace AI Chat Summarization

Chat summaries are generated only after a user opens a private or group chat, clicks **Summarize chat**, reviews the data notice, and confirms sending. The backend loads the conversation directly and checks access again. It sends at most the 100 most recent visible text messages (up to 16,000 characters) from that one chat. Attachments, voice recordings, other chats, profile data, and group metadata are excluded. Summaries are returned to the dialog only; they are not stored or posted as messages.

## Configure the free tier locally

Create a Gemini API key in Google AI Studio and set these values in the backend's local environment (the repository root `.env` is loaded by `server/server.js`):

The official `@google/genai` SDK 2.x requires Node.js 20 or newer.

```env
GEMINI_API_KEY=your_google_ai_studio_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
```

Keep the key out of frontend variables and source control. The `.env.example` values are placeholders. In Google AI Studio, use a project marked **Free** and do not link it to a Cloud Billing account. Gemini API keys inherit their project's billing tier; an unlinked free-tier project does not automatically become paid. If free-tier model quota is reached, Gemini rejects requests until quota is available rather than charging a billing account. Verify the project's current tier in AI Studio before using the key.

Google currently lists Gemini 3.5 Flash-Lite as an available stable model and lists its standard text requests as free on the Free Tier, subject to model and account rate limits. The exact request limits can vary and are shown in AI Studio. On the Free Tier, Google may use prompts and responses to improve its products, so the confirmation dialog warns users to avoid sensitive information. See [Gemini models](https://ai.google.dev/gemini-api/docs/models), [Gemini pricing and free tier](https://ai.google.dev/gemini-api/docs/pricing), and [billing tiers](https://ai.google.dev/gemini-api/docs/billing).

## Deployment

Add `GEMINI_API_KEY` as a protected backend environment secret and set `GEMINI_MODEL` in the backend environment. Keep its Google project unlinked from billing to keep usage on the no-charge free tier. Do not put the key in the frontend build environment or use a `VITE_` prefix.

The application adds its own limit of five summaries per authenticated user per five-minute window. That limiter is in-memory per backend process; a multi-instance deployment needs shared throttling at the hosting layer for an account-wide limit. The provider key's Free Tier quota is separately enforced by Google. A real API key is not required for tests.
