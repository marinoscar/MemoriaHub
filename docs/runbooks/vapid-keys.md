# Runbook: Generate, Enable, Rotate and Remove VAPID Keys (Web Push)

| Field | Value |
|-------|-------|
| **Audience** | An administrator holding the `push:write` permission (`push:read` to view) |
| **Epic / issue** | #481 / #483, #487 (documented in #489) |
| **Where** | Admin UI, `/admin/settings/push` (Settings hub, General section, card "Web Push") |
| **Design** | [Browser Notifications, Web Push and the Live Stream](../specs/browser-notifications.md) |

Web Push needs a VAPID key pair: the server signs every push with the private key, and each browser subscribes against the public key. In MemoriaHub the pair is created, stored, rotated and removed **entirely from the admin UI**. There are **no environment variables** for it, by design: storage, AI, Web Push and SMTP are runtime-configured so there is one source of truth, and there is no environment fallback to fall back to. The only deployment prerequisite is `SECRETS_ENCRYPTION_KEY`, which encrypts the private key at rest.

---

## 1. Before you start

- **HTTPS.** Browsers only expose the Push, Notification and service-worker APIs in a secure context. Serve the app over HTTPS (`localhost` also counts). Over plain HTTP the user's device reports "insecure context" and push cannot work no matter what you configure.
- **`SECRETS_ENCRYPTION_KEY` is set and stable.** The API refuses to start without it. The VAPID private key is stored AES-256-GCM encrypted with it (in the `webPush` row of `system_settings`, a separate row from the general settings, so the generic settings API never returns it). **If this key changes, the stored private key can no longer be decrypted, push silently turns off, and you must rotate** (section 4).
- **A real contact for the subject.** The VAPID *subject* is a `mailto:` address or an `https://` URL that a push service operator can use to reach you. Set one. If left blank the generic fallback `mailto:admin@example.com` is used and some push services (Apple's, notably) can reject it with `403 BadJwtToken`. `http://` URLs and anything else are refused at save time.
- **The service worker must be reachable.** `/sw.js` and `/manifest.webmanifest` are served by the web container with `no-cache`. If you add a Content-Security-Policy to a proxy in front of the app, it must allow `worker-src 'self'` and `manifest-src 'self'`, or the worker never registers.
- **Users' side.** Push reaches a user only after they have allowed notifications in their browser (the app asks once per page load when push is on) and the app has subscribed. On **iPhone/iPad, iOS/iPadOS 16.4 or later is required and the app must be installed to the Home Screen** (Share, then Add to Home Screen) and opened from there; in a Safari tab iOS exposes no notification API at all. Android Chrome and desktop browsers work in a normal tab.

Web Push is decoration on top of the notification inbox: in-app notifications, the bell and the live stream keep working whether push is configured or not.

## 2. Generate the first key pair and enable push

1. Open **Admin, Settings, Web Push** (`/admin/settings/push`). With nothing configured the page offers **Generate a key pair**.
2. Optionally enter a **Subject (contact address)**: a `mailto:` address or an `https://` URL.
3. Click generate. The server creates a P-256 VAPID pair, stores the private key encrypted, and **switches push on immediately** (generating keys is, by that action, asking for it). The page now shows the public key (copyable), the subject, the private key's last four characters and a status chip (**Enabled**).

Generate is first-time only. If any key half already exists it returns 409; use **Rotate** to replace a pair. The audit log records `push_config:generate` (with `enabled` and `subject`, never a key).

Clients pick the new key up on their next page load: `GET /api/notifications/config` then reports `pushEnabled: true` with the public key, the app prompts for permission if the device is still undecided, and the browser subscribes.

## 3. Enable, disable and change the subject

The **Enable web push** card holds the switch and the subject; save applies both (`PUT /api/admin/push-config`).

- **Disable** is always allowed and **keeps the key pair**. No pushes are sent; existing subscriptions are left in place, so switching back on needs no regeneration and devices keep working.
- **Enable** requires a key pair to exist (otherwise 409: generate first).
- **Changing the subject** takes effect on the next push; it does not disturb subscriptions.

Two other switches are separate from this page and worth knowing: **Admin, Settings, Notifications** has a deployment-wide "Send web push notifications" kill switch and a "Show browser notifications while the app is open" switch, and per-type suppression (`notifications.pushEnabled`, `browserEnabled`, `disabledTypes`). Turning push off there also hides push from clients (`GET /api/notifications/config` reports `pushEnabled: false`) even though a key pair exists. Each user also has their own push switches on `/settings`.

## 4. Rotate the key pair

Rotate when the private key may be exposed, when `SECRETS_ENCRYPTION_KEY` changed and the stored key is unreadable, or when diagnostics report the pair is broken.

1. In the **Danger zone**, click **Rotate keys**.
2. Read the consequence, type **`ROTATE`** to confirm, and confirm. (The body sent is `{ "confirmation": "ROTATE" }`; a missing or different word is a 400.)
3. A new pair replaces the old one; `enabled` is unchanged; the subject is replaced only if you provided one. The audit log records `push_config:rotate`.

### What rotation does to existing subscriptions

The server **does not delete** the `push_subscriptions` rows, and the browsers do not know anything changed. Every existing subscription was created against the old public key, so from the moment of rotation each push to it is rejected by the push service (typically HTTP 403 or 401).

- **Recovery is client-driven and happens on the next page load** with permission `granted`: the boot-time sync (`syncPushSubscription`) reads the fresh public key from `GET /api/notifications/config`, sees that the browser's subscription used a different key, unsubscribes it, subscribes again with the new key and registers the new subscription (`POST /api/notifications/push/subscriptions`, an upsert by endpoint). Users therefore start receiving pushes again the next time they open (or reload) the app. A device that is **never reopened stays silent**. An already-open tab keeps using the old key until it is reloaded.
- **Stale rows clean themselves up.** A push answered with 404/410 deletes the row immediately; any other failure increments the row's `failureCount` and the row is deleted at 5 consecutive failures. Rows that never re-subscribe are therefore pruned automatically as pushes are attempted.
- A browser that does not expose its subscription's key to the page is treated as "matches" (to avoid minting a new endpoint on every boot). Such a device may need the user to turn notifications off and on, or reinstall the app, to re-subscribe.
- Plan rotation like a small outage for push (only): tell users to reopen the app, and use the **Test & diagnostics** panel afterwards (see Troubleshooting) from each device you care about.

## 5. Remove the configuration

Removing deletes the `webPush` row (both keys) and switches push off. Every subscription becomes unusable and cannot recover until a new pair is generated.

1. **Danger zone, Remove configuration**, type **`REMOVE`** (deliberately a different word from `ROTATE`, so one confirmation cannot be reused for the other), confirm. The audit log records `push_config:remove`.
2. Clients see `pushEnabled: false` on their next config read and stop offering push. Old subscription rows are left in place and are pruned by the failure-count rule if push is later re-enabled; nothing is sent while it is off.

In-app notifications are unaffected.

## 6. Recovery reference

| Situation | Symptom | Fix |
|---|---|---|
| Never configured | Page offers "Generate a key pair"; clients report `pushEnabled: false` | Section 2 |
| Switched off | Chip "Disabled"; nothing is sent | Turn the switch on and save (keys are kept) |
| `SECRETS_ENCRYPTION_KEY` changed | Chip may still read "Enabled" but the API logs "Web Push private key could not be decrypted"; push is off; the test says the key pair is "incomplete or unreadable" | Rotate (section 4), then have users reopen the app |
| Stored row corrupted / hand-edited | Warning "The stored web push configuration could not be read"; push is off | Generate (if the row was unusable) or Remove, then Generate |
| Private key exposed | n/a | Rotate |
| Push works for some devices only | Test shows a mix of `sent` and `failed`/`pruned` | Reopen the app on the failing devices; see the table below |

## Troubleshooting

Use the **Test & diagnostics** card on `/admin/settings/push` (visible once a key pair exists). **Send test push** walks the whole chain and sends a real signed push to **your own** subscriptions only; the API always answers 200 and a failed send is the diagnostic. It does not create a notification, and repeated tests cannot prune your healthy devices (it never counts non-404/410 failures). The walkthrough checks, in order: browser support, notification permission, service worker, this browser's push subscription, registration with the server, the server test push, and delivery to this device (a `push-test-received` acknowledgement from the service worker, with latency). **Show local notification** checks that this device can display a notification at all, independent of push. **Copy diagnostics** produces a report that is safe to paste into an issue (no keys, only an endpoint preview).

The panel prints plain-English hints; this table maps each to its cause and fix.

| Hint shown | Cause | What to do |
|---|---|---|
| "Web Push is not configured. Use "Generate keys" on this page..." | No `webPush` row | Section 2 |
| "Web Push is switched off. Enable it on this page..." | `enabled: false` | Section 3 |
| "Web Push is enabled but its key pair is incomplete or unreadable. Rotate the key pair, then reload the app so browsers re-subscribe." | Missing key half, or the private key cannot be decrypted (`SECRETS_ENCRYPTION_KEY` changed) | Rotate (section 4) |
| "The VAPID key pair is broken. Rotate it, then reload the app on each device so it re-subscribes." | Public key is not a valid P-256 point, or the private key does not derive the public key | Rotate |
| "Set the VAPID subject to a real mailto: address or an https:// URL. Apple's push service rejects invalid subjects with 403 BadJwtToken." | Stored subject is not valid | Save a valid subject |
| "Set a real VAPID subject (your contact mailto: address). The generic fallback can be rejected by some push services." | Subject still the `mailto:admin@example.com` fallback | Save your contact address |
| "This browser did not report a push subscription. Allow notifications for this site, then reload the page so it subscribes." | Permission not granted, or the browser has no subscription | Allow notifications in the browser's site settings, reload |
| "No subscription for this browser is registered on the server. Grant notification permission and reload the page so it re-subscribes." | Browser has a subscription the server does not (row pruned, or sync never ran) | Reload the app with permission granted |
| "This browser's subscription was created with a different VAPID key, so the push service will reject pushes to it. Reload the page so it re-subscribes with the current key." | Key rotated since this browser subscribed | Reload the page |
| "You have no push subscriptions. Open the app in a browser, allow notifications, and reload, then run the test again." | The account has zero subscription rows | Same; on iOS install the app first |
| "The subscription at <push service> has expired or been revoked (HTTP 404/410) and was removed. Reload the app on that device to re-subscribe." | The push service dropped the endpoint | Reload the app on that device |
| "403 from <push service>: the VAPID key pair usually does not match the one the subscription was created with..." | Rotation not yet picked up by that device, or a bad subject | Reload the app on that device; check the subject |
| "401 from <push service>: the push service rejected the VAPID signature. Check the subject and the key pair." | Bad signature/subject | Check subject; rotate if the pair is suspect |
| "429 from <push service>: the push service is rate-limiting this server. Wait a few minutes before testing again." | Push service throttling | Wait |
| "5xx from <push service>: the push service had an error. This is usually temporary." | Provider outage | Retry later |
| "Could not reach <push service> (network error). Check that this server can make outbound HTTPS requests to the push service." | The API container cannot reach FCM / Mozilla autopush / Apple | Allow outbound HTTPS from the API (firewall, proxy, DNS) |
| "The push service accepted the test. If nothing appeared, check the OS notification settings and Do Not Disturb, the site's notification permission, and that the app's service worker is installed." | Delivery to the push service worked; display is blocked locally | Check OS focus/DND, site permission, that `/sw.js` registered (browser devtools, Application, Service Workers) |
| "Push is turned off for "<type>" by the admin notification policy." | The type is in `notifications.disabledTypes`, or push is disabled deployment-wide | Admin, Settings, Notifications |
| "You have turned off push for "<type>" in your notification preferences." | Your own preference | `/settings`, Notifications |

Other checks worth doing:

- **iOS shows "install to Home Screen" instead of a permission button.** That is the `ios-needs-install` state: open the app from the Home Screen icon, on iOS/iPadOS 16.4 or later.
- **"Insecure context".** Serve over HTTPS.
- **"Blocked" on a device.** The user denied permission; only the user can undo it (site settings, then Notifications, then Allow; on Android also check the app's notification categories). Then reload.
- **Push arrives but the toast/bell does not update in other tabs.** The live stream is separate: check that the reverse proxy passes `/api/notifications/stream` unbuffered (a dedicated `location` block in `infra/nginx/nginx.conf`) and verify through the proxy, since buffering is invisible against the API port.
- **The API log** records `Web Push ... could not be decrypted`, `stored Web Push settings are invalid`, and per-delivery failures with counts only (never a key, body or endpoint). Delivery attempts per notification are also audited in the `notification_deliveries` table.

## 7. Summary checklist

- [ ] The app is served over HTTPS and `SECRETS_ENCRYPTION_KEY` is set and stable
- [ ] `/admin/settings/push`: Generate a key pair, with a real `mailto:`/`https://` subject; status chip reads **Enabled**
- [ ] `/admin/settings/notifications`: Web push is not switched off deployment-wide
- [ ] On a real device (installed to the Home Screen on iOS 16.4+): allow notifications, run **Send test push**, and see it arrive (overall `sent`)
- [ ] After any **Rotate**, tell users to reopen the app, then re-run the test from a representative device
- [ ] Nothing was added to an environment file: there are no VAPID variables to set
