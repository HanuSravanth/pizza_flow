// POST /api/tables — server-side writes for seating sessions, the customer
// side of table occupancy. Mirrors /api/orders/update: runs with the
// service-role key because anon writes to a table it doesn't own reliably
// need this route (see the update-order route's comment for the underlying
// RLS reliability issue in this project's Supabase instance).
// Body: { action: "open" | "close", tableNumber: number }

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function POST(request: Request) {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "The server is missing SUPABASE_SERVICE_ROLE_KEY — table seating cannot be saved." },
      { status: 500 }
    );
  }

  let body: { action?: string; tableNumber?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { action, tableNumber } = body;
  if (!Number.isInteger(tableNumber) || (tableNumber as number) < 1) {
    return NextResponse.json({ error: "A valid tableNumber is required." }, { status: 400 });
  }

  if (action === "open") {
    const { error } = await admin.from("table_sessions").insert({ table_number: tableNumber });
    if (error) {
      // Unique-violation on the "one open session per table" index: someone
      // else seated this table first.
      if (error.code === "23505") return NextResponse.json({ ok: true, occupied: true });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, occupied: false });
  }

  if (action === "close") {
    const { error } = await admin
      .from("table_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("table_number", tableNumber)
      .eq("status", "open");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be 'open' or 'close'." }, { status: 400 });
}
