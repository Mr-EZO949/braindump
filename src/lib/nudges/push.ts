// Server-side web-push delivery. Reads each user's saved
// push_subscriptions and fires sendNotification once per device. Failed
// deliveries with status 410 (Gone) prune the dead subscription so we
// don't keep retrying it.
//
// VAPID keys are env-driven. If they're missing this no-ops silently —
// the in-app ribbon is the primary surface; push is a bonus.

import type { SupabaseClient } from "@supabase/supabase-js";
import webpush, { type WebPushError } from "web-push";

type PushSubRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type NudgeForPush = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  node_id: string | null;
};

let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export async function deliverPushForNudges(
  supabase: SupabaseClient,
  nudges: NudgeForPush[],
): Promise<{ sent: number; pruned: number }> {
  if (nudges.length === 0) return { sent: 0, pruned: 0 };
  if (!ensureVapidConfigured()) return { sent: 0, pruned: 0 };

  const userIds = [...new Set(nudges.map((n) => n.user_id))];
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (!subs || subs.length === 0) return { sent: 0, pruned: 0 };

  const subsByUser = new Map<string, PushSubRow[]>();
  for (const row of subs as Array<PushSubRow & { user_id: string }>) {
    const list = subsByUser.get(row.user_id) ?? [];
    list.push({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth });
    subsByUser.set(row.user_id, list);
  }

  const deadEndpoints: string[] = [];
  let sent = 0;

  for (const nudge of nudges) {
    const userSubs = subsByUser.get(nudge.user_id);
    if (!userSubs) continue;

    const payload = JSON.stringify({
      nudge_id: nudge.id,
      title: nudge.title,
      body: nudge.body,
      node_id: nudge.node_id,
    });

    await Promise.all(
      userSubs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload,
          );
          sent++;
        } catch (err) {
          const status = (err as WebPushError).statusCode;
          if (status === 404 || status === 410) {
            // Browser told us this subscription is gone. Prune.
            deadEndpoints.push(sub.endpoint);
          } else {
            console.error("[push] sendNotification failed:", status, err);
          }
        }
      }),
    );
  }

  let pruned = 0;
  if (deadEndpoints.length > 0) {
    const { count } = await supabase
      .from("push_subscriptions")
      .delete({ count: "exact" })
      .in("endpoint", deadEndpoints);
    pruned = count ?? 0;
  }

  // Mark these nudges as pushed_at so we never resend on retry.
  const nudgeIds = nudges.map((n) => n.id);
  await supabase
    .from("nudges")
    .update({ pushed_at: new Date().toISOString() })
    .in("id", nudgeIds);

  return { sent, pruned };
}
