// POST /api/ai/assistant — chat-to-order.
// Body: { message: string, menu: Menu, cart?: CartLineIds[] }
// Returns a draft order the client re-validates against the live menu (and
// its own cart) before anything reaches the cart. The AI proposes; the
// rules dispose.

import { NextResponse } from "next/server";
import { isAiEnabled } from "@/lib/data";
import { ORDER_ASSISTANT_SYSTEM_PROMPT } from "@/lib/prompts";
import { AiUnavailableError, chatCompletion, parseJsonReply } from "@/lib/openrouter";
import type { Menu } from "@/lib/types";

interface DraftLine {
  baseId: string;
  pizzaId: string;
  toppingIds: string[];
  quantity: number;
}

interface CartLineIds {
  baseId: string;
  pizzaId: string;
  toppingIds: string[];
  quantity: number;
}

interface CartUpdate {
  cartIndex: number;
  addToppingIds: string[];
  removeToppingIds: string[];
}

export async function POST(request: Request) {
  // Admin kill switch, re-checked server-side so it can't be bypassed by
  // calling this endpoint directly even if the UI is hidden client-side.
  if (!(await isAiEnabled())) {
    return NextResponse.json(
      { error: "AI features are currently turned off by the admin — please order using the menu below." },
      { status: 503 }
    );
  }

  let body: { message?: string; menu?: Menu; cart?: CartLineIds[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const message = (body.message ?? "").trim().slice(0, 500);
  const menu = body.menu;
  const cart = Array.isArray(body.cart) ? body.cart : [];
  if (!message || !menu?.bases?.length || !menu?.pizzas?.length) {
    return NextResponse.json({ error: "A message and the menu are required" }, { status: 400 });
  }

  const menuText = [...menu.bases, ...menu.pizzas, ...menu.toppings]
    .map((i) => `${i.id} | ${i.name} | ${(i.pricePaise / 100).toFixed(2)}`)
    .join("\n");

  const cartText = cart.length
    ? cart
        .map((line, i) => {
          const base = menu.bases.find((b) => b.id === line.baseId);
          const pizza = menu.pizzas.find((p) => p.id === line.pizzaId);
          const toppingNames = line.toppingIds
            .map((id) => menu.toppings.find((t) => t.id === id)?.name)
            .filter((n): n is string => Boolean(n));
          return (
            `${i} | ${line.quantity}x ${pizza?.name ?? "unknown pizza"} on ${base?.name ?? "unknown base"}` +
            (toppingNames.length ? ` with ${toppingNames.join(", ")}` : "")
          );
        })
        .join("\n")
    : "(empty)";

  try {
    const reply = await chatCompletion({
      system: ORDER_ASSISTANT_SYSTEM_PROMPT.replace("{{MENU}}", menuText).replace("{{CART}}", cartText),
      user: message,
      jsonMode: true,
    });
    const draft = parseJsonReply<{ lines?: DraftLine[]; cartUpdates?: CartUpdate[]; note?: string }>(reply);
    return NextResponse.json({
      lines: Array.isArray(draft.lines) ? draft.lines : [],
      cartUpdates: Array.isArray(draft.cartUpdates) ? draft.cartUpdates : [],
      note: typeof draft.note === "string" ? draft.note : "",
    });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return NextResponse.json(
        { error: "The assistant is unavailable right now — please order using the menu below." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "The assistant could not understand that — please try rephrasing or use the menu." },
      { status: 502 }
    );
  }
}
