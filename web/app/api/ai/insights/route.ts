// POST /api/ai/insights — Owner Insights Copilot.
// Body: { question: string, aggregates: OrderAggregates, ratings?: RatingSummary, promoCodes?: PromoCodeStats[] }
// All of it is computed deterministically from the database (analytics.ts);
// the LLM only narrates it. It never touches the database.

import { NextResponse } from "next/server";
import { getAiModel, getAiPrompt, getOpenRouterApiKey, isAiFeatureEnabled } from "@/lib/data";
import { AiUnavailableError, chatCompletion } from "@/lib/openrouter";
import type { OrderAggregates, PromoCodeStats, RatingSummary } from "@/lib/analytics";

export async function POST(request: Request) {
  if (!(await isAiFeatureEnabled("insights"))) {
    return NextResponse.json(
      { error: "AI features are currently turned off in Admin > Settings > AI." },
      { status: 503 }
    );
  }

  let body: {
    question?: string;
    aggregates?: OrderAggregates;
    ratings?: RatingSummary;
    promoCodes?: PromoCodeStats[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const question = (body.question ?? "").trim().slice(0, 300);
  const aggregates = body.aggregates;
  if (!question || !aggregates) {
    return NextResponse.json({ error: "A question and sales data are required" }, { status: 400 });
  }

  try {
    const [prompt, model, apiKey] = await Promise.all([
      getAiPrompt("insights"),
      getAiModel(),
      getOpenRouterApiKey(),
    ]);
    const answer = await chatCompletion({
      system: prompt
        .replace("{{GENERATED_AT}}", aggregates.generatedAt)
        .replace("{{AGGREGATES}}", JSON.stringify(aggregates, null, 1))
        .replace("{{RATINGS}}", JSON.stringify(body.ratings ?? "no ratings data provided", null, 1))
        .replace("{{PROMO_CODES}}", JSON.stringify(body.promoCodes ?? "no promo code data provided", null, 1)),
      user: question,
      maxTokens: 400,
      model,
      apiKey: apiKey ?? undefined,
    });
    return NextResponse.json({ answer });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return NextResponse.json(
        { error: "The copilot is unavailable right now. The orders table below has all the raw data." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: "Could not answer that — please rephrase." }, { status: 502 });
  }
}
