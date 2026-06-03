// One-off VAPID key generator. Run ONCE:
//   node scripts/gen-vapid-keys.mjs
// Then paste the output into .env.local AND set the same vars on Vercel.
//
// The public key gets exposed to the browser (it's safe to publish — that's
// the whole point of asymmetric crypto). The private key never leaves the
// server: it signs push payloads so the push server (FCM / Apple) trusts
// they came from us.

import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("Add these to .env.local AND Vercel env vars:\n");
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:ospanzhangir2005@gmail.com`);
