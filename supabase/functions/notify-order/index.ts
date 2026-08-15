// Supabase Edge Function: notify-order
// Triggered by a Database Webhook on INSERT into the `orders` table.
// Sends an email to managers via Resend whenever a new order is placed.
// Does NOT fire on updates (stage checklist toggles, marking exported, etc.) —
// only on the initial insert of a new order.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const MANAGER_EMAILS = (Deno.env.get("MANAGER_EMAILS") || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "onboarding@resend.dev";

function money(n) {
  const v = Number(n);
  return isFinite(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "$0.00";
}

serve(async (req) => {
  // Shared-secret check so this endpoint can't be spammed by strangers who find the URL.
  if (WEBHOOK_SECRET) {
    const provided = req.headers.get("x-webhook-secret");
    if (provided !== WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set.");
    return new Response("server not configured", { status: 500 });
  }
  if (MANAGER_EMAILS.length === 0) {
    console.error("MANAGER_EMAILS is not set.");
    return new Response("server not configured", { status: 500 });
  }

  try {
    const payload = await req.json();
    // Supabase Database Webhooks send { type, table, record, old_record }
    const record = payload?.record;
    const order = record?.data;
    if (!order) return new Response("no order data in payload", { status: 200 });

    const lineText = (order.lines || [])
      .map((l) => {
        const qty = Number(l.qty).toFixed(2);
        const price = money(l.price);
        const comment = l.comment ? ` (${l.comment})` : "";
        return `  • ${l.itemName} — ${qty} lb @ ${price}/lb${comment}`;
      })
      .join("\n");

    const subject = `New order placed: ${order.invoiceNo} — ${order.customerName}`;
    const text = `A new order was placed.

Invoice: ${order.invoiceNo}
Customer: ${order.customerName}
Date: ${order.date}
Total: ${money(order.subtotal)}

Items:
${lineText}
`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: MANAGER_EMAILS,
        subject,
        text,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error("Resend error:", errText);
      return new Response("email send failed", { status: 500 });
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
