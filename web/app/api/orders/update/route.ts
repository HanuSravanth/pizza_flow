// POST /api/orders/update — server-side write for the two order mutations the
// public ordering page needs after the initial insert: refreshing running
// bill totals on each "Confirm and order", and marking payment_mode/status on
// "Finish and pay". Runs with the service-role key (bypasses RLS) because the
// anon-role RLS "update while placed" policy — despite correct grants/policy
// definition — was not reliably applying in this project's Supabase instance;
// routing through the server sidesteps that entirely.
// Body: { orderId: string, fields: Record<string, unknown> }

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const ALLOWED_FIELDS = new Set([
  "customer_name",
  "phone",
  "table_number",
  "subtotal",
  "discount",
  "gst",
  "total",
  "payment_mode",
  "status",
]);

export async function POST(request: Request) {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "The server is missing SUPABASE_SERVICE_ROLE_KEY — order updates cannot be saved." },
      { status: 500 }
    );
  }

  let body: { orderId?: string; fields?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const orderId = body.orderId;
  const fields = body.fields;
  if (!orderId || typeof orderId !== "string" || !fields || typeof fields !== "object") {
    return NextResponse.json({ error: "orderId and fields are required." }, { status: 400 });
  }

  // An admin "Close table" cancels the order out from under an in-progress
  // customer session. Both callers of this route (confirmOrder's running-
  // total refresh, finishAndPayOrder's payment write) must only ever mutate
  // an order that is still 'placed' — otherwise a customer could keep
  // confirming/paying against an order staff already cancelled.
  const { data: current, error: statusError } = await admin
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });
  if (!current || current.status !== "placed") {
    return NextResponse.json(
      {
        error: "This table was closed by staff — please contact the waiter and start a new order.",
        closed: true,
      },
      { status: 409 }
    );
  }

  const updateFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key)) updateFields[key] = value;
  }
  if (Object.keys(updateFields).length === 0) {
    return NextResponse.json({ error: "No recognised fields to update." }, { status: 400 });
  }

  const { error } = await admin.from("orders").update(updateFields).eq("id", orderId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
