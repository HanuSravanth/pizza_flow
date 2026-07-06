import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  let body: {
    customerName?: string;
    waitedMinutes?: number;
    groupSize?: number;
    currentOccupancy?: number;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const customerName = (body.customerName ?? "Valued Guest").trim().slice(0, 50);
  const waitedMinutes = Number(body.waitedMinutes ?? 0);
  const groupSize = Number(body.groupSize ?? 2);
  const currentOccupancy = Number(body.currentOccupancy ?? 15);
  const totalCapacity = Number(body.totalCapacity ?? 15);

  // 1. Calculate deterministic tier and offer for fallback/validation
  let waitTier = "Bronze";
  let suggestedIncentive = "Complimentary Welcome Drink 🥤";

  if (waitedMinutes > 45) {
    waitTier = "VIP Elite";
    suggestedIncentive = "25% OFF Total Bill + Free Topping & Choice of Starter 👑";
  } else if (waitedMinutes > 30) {
    waitTier = "Gold Premium";
    suggestedIncentive = "15% OFF Total Bill + Complimentary Soft Drink 🥤";
  } else if (waitedMinutes > 20) {
    waitTier = "Silver Plus";
    suggestedIncentive = "Complimentary Fresh Garlic Bread + Choice of Dipping Sauce 🫓";
  } else if (waitedMinutes > 10) {
    waitTier = "Silver";
    suggestedIncentive = "Complimentary Fresh Garlic Bread 🫓";
  }

  const prompt = `You are the hospitality manager at SliceMatic, a premium pizza outlet in New Ashok Nagar, Delhi.
All our ${totalCapacity} dine-in tables are fully occupied, and we have a waitlist during rush hour.
Draft a short, extremely warm, and personalized apology and offer message for a waiting customer to keep them happy and engaged so they don't leave.

Customer details:
- Name: "${customerName}"
- Party Size: ${groupSize} guests
- Wait time so far: ${waitedMinutes} minutes
- Current state: All ${totalCapacity} tables are full (100% capacity).
- Wait list tier: "${waitTier}"
- Assigned hospitality gesture: "${suggestedIncentive}"

Instructions:
1. Address "${customerName}" directly with genuine warmth, acknowledging their wait of ${waitedMinutes} minutes.
2. Formally offer the designated gesture: "${suggestedIncentive}" as a token of our sincere appreciation.
3. Keep the tone friendly, apologetic, yet enthusiastic about having them dine with us.
4. Keep the message highly readable, engaging, and under 80 words.
5. Do not include any technical terms or system statuses in the message.
6. Respond with a valid JSON object in EXACTLY this structure, with no markdown code blocks or wrapper tags:
{
  "message": "The written greeting/apology goes here",
  "suggestedIncentive": "Simplified list of rewards offered",
  "waitTier": "The assigned tier name"
}`;

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.7,
        },
      });

      const responseText = response.text;
      if (responseText) {
        // Strip markdown blocks if returned
        let cleanJson = responseText.trim();
        if (cleanJson.startsWith("```json")) {
          cleanJson = cleanJson.slice(7);
        }
        if (cleanJson.endsWith("```")) {
          cleanJson = cleanJson.slice(0, -3);
        }
        cleanJson = cleanJson.trim();
        
        const parsed = JSON.parse(cleanJson);
        if (parsed.message && parsed.suggestedIncentive) {
          return NextResponse.json({
            message: parsed.message,
            suggestedIncentive: parsed.suggestedIncentive,
            waitTier: parsed.waitTier || waitTier,
            isAi: true,
          });
        }
      }
    } catch (err) {
      console.error("Waitlist AI route error:", err);
      // Fallback to rule-based generation if AI fails
    }
  }

  // Beautiful deterministic fallback when API keys are not available
  const drinkMsg = groupSize > 2 ? "chilled beverages for the whole group" : "chilled beverage on us";
  const ruleMessages: Record<string, string> = {
    "VIP Elite": `Hi ${customerName}, we are incredibly sorry to keep you waiting! Our tables are completely packed tonight. Since you have been waiting patiently for ${waitedMinutes} minutes, we would love to offer you a special VIP Elite 25% discount on your entire bill, plus a free garlic bread starter and extra toppings on us. Thank you for staying with us!`,
    "Gold Premium": `Dear ${customerName}, thank you so much for your amazing patience! We've been experiencing a massive weekend rush with all ${totalCapacity} tables full. As a token of our appreciation for waiting ${waitedMinutes} minutes, please enjoy 15% off your total bill tonight, along with a free round of soft drinks. We are getting your table ready as fast as we can!`,
    "Silver Plus": `Hi ${customerName}, we really appreciate you holding on! All our tables are occupied, but we expect to seat your party of ${groupSize} very soon. Since you've waited ${waitedMinutes} minutes, we have locked in a complimentary portion of our freshly baked Garlic Bread with delicious cheese dip for you to start with!`,
    Silver: `Hi ${customerName}, thank you for your patience! We are fully full right now, but your wait of ${waitedMinutes} minutes deserves a treat. We have secured a free portion of our famous Garlic Bread for your table as soon as you are seated!`,
    Bronze: `Hello ${customerName}, welcome to SliceMatic! We're currently experiencing a full house. While we get your table ready, please enjoy a complimentary ${drinkMsg} to make your wait of ${waitedMinutes} minutes a bit sweeter. Thank you for dining with us!`,
  };

  return NextResponse.json({
    message: ruleMessages[waitTier] || ruleMessages["Bronze"],
    suggestedIncentive,
    waitTier,
    isAi: false,
  });
}
