// Server-side OpenRouter helper. The API key lives only in server env —
// every AI call goes browser -> our API route -> OpenRouter, never direct.

import { DEFAULT_MODEL } from "./aiCatalog";
import { GoogleGenAI } from "@google/genai";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class AiUnavailableError extends Error {}

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
}

export async function chatCompletion(params: {
  system: string;
  user: string;
  jsonMode?: boolean;
  maxTokens?: number;
  // The admin-selected model (settings.ai_model), resolved by the caller.
  // Falls back to OPENROUTER_MODEL then DEFAULT_MODEL if not provided.
  model?: string;
  // The resolved OpenRouter key (admin-set in the UI, or OPENROUTER_API_KEY),
  // supplied by the caller. Falls back to the env var if not provided.
  apiKey?: string;
}): Promise<string> {
  const apiKey = params.apiKey || process.env.OPENROUTER_API_KEY;

  if (!apiKey && process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: params.user,
        config: {
          systemInstruction: params.system,
          responseMimeType: params.jsonMode ? "application/json" : "text/plain",
        },
      });

      const content = response.text;
      if (typeof content !== "string" || !content.trim()) {
        throw new AiUnavailableError("Gemini returned an empty response");
      }
      return content;
    } catch (err: any) {
      console.error("Gemini API error:", err);
      throw new AiUnavailableError(`Gemini API error: ${err?.message || err}`);
    }
  }

  if (!apiKey) {
    throw new AiUnavailableError("No OpenRouter API key or Gemini API key is configured");
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pizzaflow.vercel.app",
      "X-Title": "PizzaFlow - SliceMatic",
    },
    body: JSON.stringify({
      model: params.model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      temperature: 0.3,
      max_tokens: params.maxTokens ?? 700,
      ...(params.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    // A hung LLM call must never hang the counter: fail fast, order continues.
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AiUnavailableError(`OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiUnavailableError("OpenRouter returned an empty response");
  }
  return content;
}

/** Parse a JSON object out of an LLM reply, tolerating markdown fences. */
export function parseJsonReply<T>(reply: string): T {
  const cleaned = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as T;
}
