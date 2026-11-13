# Meta Conversions API (CAPI) Research for CRM Integration

Retrieval date: 2026-11-13. Primary source: Meta for Developers. The legacy path `https://developers.facebook.com/docs/marketing-api/conversions-api/` now redirects its content to `https://developers.facebook.com/documentation/ads-commerce/conversions-api/`. Pages were read through WebFetch and through the raw `.md` variants listed in `https://developers.facebook.com/documentation/ads-commerce/llms.txt`. Items marked **unverified** were not confirmed in the pages read.

Source pages (all retrieved 2026-11-13), base `https://developers.facebook.com/documentation/ads-commerce/`:
- `conversions-api` (overview), `conversions-api/get-started`, `conversions-api/using-the-api`, `conversions-api/verifying-setup`, `conversions-api/support`, `conversions-api/best-practices`
- `conversions-api/parameters`, `.../parameters/main-body`, `.../parameters/server-event`, `.../parameters/customer-information-parameters`, `.../parameters/custom-data`, `.../parameters/fbp-and-fbc`, `.../parameters/external-id`
- `conversions-api/deduplicate-pixel-and-server-events`
- `conversions-api/offline-events`, `conversions-api/business-messaging`
- `conversions-api/conversion-leads-integration` (+ `/payload-specification`, `/faq`)
- `marketing-api/overview/data-processing-options`
- Standard events list: `https://developers.facebook.com/docs/meta-pixel/reference` (only the event names were matched; per-event required parameters not read, unverified)

## 1. Endpoint, version, batching

- Endpoint: `POST https://graph.facebook.com/{API_VERSION}/{DATASET_ID}/events?access_token={TOKEN}`. The `using-the-api` page writes the path segment as `{PIXEL_ID}`; the business-messaging page writes `{DATASET_ID}`. Same endpoint (see section 3).
- Current Graph API version in the docs: **v27.0** (used in the curl example and in the messaging examples). Meta does not state a sunset date on these pages (unverified). Pin the version in configuration.
- Body is JSON with a `data` array of event objects. Optional top-level fields: `test_event_code`, `partner_agent` (appears in the messaging sample).
- Batch limit: up to **1,000 events** per request in `data`. Meta recommends sending events as soon as they occur, ideally within an hour.
- Events are verifiable in Events Manager within about 20 minutes.
- If any event in a batch is invalid, the request returns an error, but valid events that carry an `event_id` are still accepted (per `using-the-api`). Behaviour for valid events without `event_id` is unclear (unverified).

## 2. Authentication

- An access token is passed as the `access_token` query parameter or form field on every call.
- Token generation in Events Manager: select the Pixel/dataset, Settings tab, Conversions API section, "Set up manually", "Generate access token". Visible only to users with developer privileges on the business. This creates a Conversions API app and a system user automatically, without App Review.
- Alternative: use your own app and system user. In Meta Business Suite settings, assign the dataset to the system user and click Generate Token. No App Review needed.
- Tokens generated in Events Manager work with all API versions since v12.0.
- Token expiry and rotation policy: not stated on the pages read (unverified).
- Business messaging uses different token permissions: `page_events` (Messenger), `whatsapp_business_management` and `whatsapp_business_manage_events` (WhatsApp), `instagram_manage_events` (Instagram). Accepted token types for WhatsApp include Embedded Signup token, Business Integration System User token, System User token, or User token with the permissions. The business-messaging guide is aimed at Business Messaging Partners and requires Marketing API Access Tier (Full Access: 500 successful calls in 15 days, per the page's warning banner; the body text still says 1,500). A direct advertiser CRM may not qualify for that path (unverified).
- Server-side token handling: store the token as a secret; never expose it in the browser.

## 3. Dataset versus Pixel

The docs use both terms. Get Started speaks of "Pixel ID"; the overview and the messaging guide speak of "dataset ID". A dataset is the consolidated container that collects events from Meta Pixel, App Events API/SDK, Offline Conversions API, messaging events and CAPI in one place. For website pixels, the Pixel ID and dataset ID are the same ID in practice and the `/events` edge accepts it (inference from the docs using both names for the same path; no explicit statement). For offline events, a `GET` on the Ads Pixel endpoint with `?fields=is_consolidated_container` tells whether the dataset can take offline events. For messaging, a dataset can be created with `POST /{PAGE_ID}/dataset` (Messenger), the equivalent for the Instagram user, or the WhatsApp equivalent. A single CRM dataset can receive web, offline, CRM and messaging events if consolidated.

## 4. Event parameters (server event)

| Parameter | Status | Rule |
|---|---|---|
| `event_name` | Required | Standard or custom event name. Used with `event_id` for deduplication. |
| `event_time` | Required | Unix timestamp in seconds, GMT. Up to **7 days** before send time. If any `event_time` in the batch is older than 7 days, the whole request errors and no events are processed. For `physical_store` events upload within **62 days**. Conversion Leads: timestamp must be after lead creation or the event may be discarded. |
| `action_source` | Required | `email`, `website`, `app`, `phone_call`, `chat`, `physical_store`, `system_generated`, `business_messaging`, `other`. You attest it is accurate. |
| `user_data` | Required | Customer information; see section 5. |
| `event_source_url` | Optional, required for website events | Browser URL; should match the verified domain. Website events also need `client_user_agent`. |
| `event_id` | Optional, recommended | Any unique string; with `event_name` used for dedup. Use an order number or transaction ID where one exists. |
| `custom_data` | Optional | Business data; see section 8. |
| `opt_out` | Appears in the official sample payload as `"opt_out": false` on the event; no parameter description in the pages read. Semantics **unverified**. |
| `data_processing_options` | Optional | Array; the only accepted value is `LDU`. An empty array explicitly means not limited. |
| `data_processing_options_country` | Required if `LDU` sent | `1` (United States) or `0` (Meta geolocates). |
| `data_processing_options_state` | Required if `LDU` sent without an IP address | `1000` (California) or `0` (geolocate). If a country is set, a state must be set too. |
| `messaging_channel` | Used with `action_source=business_messaging` | Values seen in the samples: `messenger`, `whatsapp`, `instagram`. Full enum **unverified**. |
| `referrer_url`, `customer_segmentation`, `original_event_data`, `app_data`/`extinfo` | Optional (app data required for app events) | `customer_segmentation` enum values are listed in the server-event page. |
| `test_event_code` | Optional, top-level next to `data` | From Events Manager, Test Events tab. Remove in production. Test events are not dropped; they still feed targeting and measurement. |

## 5. Customer information parameters: normalization and hashing

Hash with SHA-256 after normalization, output lowercase hex. The official sample payload shows hex digests. If you use the Meta Business SDK, hashing is done automatically.

**Hashed (normalize first)**

| Field | Normalization rule (as documented) |
|---|---|
| `em` | Trim leading and trailing spaces, lowercase. |
| `ph` | Remove symbols, letters and leading zeros. Always include country code (US example: `(650)555-1212` becomes `16505551212`). |
| `fn`, `ln` | Lowercase, no punctuation. Roman a-z recommended; UTF-8 for special characters. |
| `ge` | Lowercase initial: `f` or `m`. |
| `db` | `YYYYMMDD` (year 1900 to current, month 01-12, day 01-31). |
| `ct` | Lowercase, no punctuation, special characters or spaces. |
| `st` | US: lowercase 2-character ANSI abbreviation. Non-US: lowercase, no punctuation or spaces. |
| `zp` | Lowercase, no spaces or dashes. US: first 5 digits. UK: area/district/sector format (example `m11ae`). |
| `country` | Lowercase ISO 3166-1 alpha-2 (for example `us`). |
| `external_id` | Hashing **recommended, not required**. Any unique advertiser ID; keep the same format across all channels. |

**Must NOT be hashed**: `client_ip_address` ("must never be hashed", valid IPv4/IPv6, no spaces), `client_user_agent` (required for website events), `fbc`, `fbp`, `subscription_id`, `fb_login_id` (integer), `lead_id` (integer), `anon_id` (app events), `page_id`, `page_scoped_user_id`, `ctwa_clid`, `ig_account_id`, `ig_sid`.

`madid`: no hashing rule stated on the page read; **unverified**. Fields accept a string or a list (multiple values per person).

`fbc` format: `fb.{subdomainIndex}.{creationTimeMs}.{fbclid}`. `fb` is a fixed prefix; subdomainIndex `com`=0, `example.com`=1, `www.example.com`=2 (use 1 if generated server-side); creation time in **milliseconds**; `fbclid` is case-sensitive, never lowercase it. Example: `fb.1.1554763741205.AbCdEf...`. Recommended `_fbc` cookie lifetime: 90 days. `fbp` format: `fb.{subdomainIndex}.{creationTimeMs}.{randomNumber}` (example in the sample: `fb.1.1558571054389.1098115397`). The parameter builder library adds an appendix to these values (see its page).

**Event Match Quality (EMQ)**: scored 1 to 10 in Events Manager Overview or via the Setup Quality API (Dataset Quality API). Meta recommends 6.0 or higher. Send as many identifiers as you legitimately hold: `em`, `ph`, `external_id`, `fbc`, `fbp`, IP, user agent.

## 6. Deduplication

- Primary method: `event_name` plus `event_id` identical between browser (`event` plus `eventID`, fourth argument of `fbq('track', ...)`) and server (`event_name` plus `event_id`).
- Fallback: `event_name` plus `fbp` and/or `external_id` on both sources. Works only browser first, then server; server events are not discarded if no browser event was seen in the prior 48 hours.
- Window: events are deduplicated when received within **48 hours** of the first event with the same key. If server and browser events arrive within about 5 minutes of each other, the browser/app event is favored; otherwise the first received is kept.
- Same-source duplicates (two server events with identical keys) are not deduplicated by the fallback method; the `using-the-api` page says repeating the same `event_id` and `event_name` keeps only the first, which makes batch retries safe. Treat server-only idempotency as plausible but apply your own idempotency keys as well.
- No dedup is needed if the same event is sent only through CAPI.

## 7. Test Events and diagnostics

- Test Events tool: Events Manager, data source, Test Events tab; it gives a code such as `TEST123` to send as `test_event_code`.
- Events Manager diagnostics shown in the pages: events received, discarded (consent controls and other policies), processed; connection method per event; event freshness (average delay by `event_time`); event deduplication tab (rate deduplicated, dedupe key usage, overlap); EMQ. A named "Diagnostics" tab was not described in the pages read (unverified).

## 8. Standard events and Purchase

Standard event names matched on the Pixel reference page: AddPaymentInfo, AddToCart, AddToWishlist, CompleteRegistration, Contact, CustomizeProduct, Donate, FindLocation, InitiateCheckout, Lead, Purchase, Schedule, Search, StartTrial, SubmitApplication, Subscribe, ViewContent. `Purchase` requires `custom_data.value` (numeric monetary amount; also required for any value-optimized event) and `custom_data.currency` (ISO 4217 three-letter code). Other `custom_data` fields include `order_id`, `content_ids`, `content_type`, `contents`, `net_revenue`, `predicted_ltv`, `lead_event_source`, `num_items`, `search_string`, `delivery_category`.

## 9. CRM and offline (Conversion Leads)

- Product: Lead Ads "Conversion Leads" optimization. Supports only native Instant Forms on Facebook/Instagram.
- Payload per `payload-specification`: `event_name` is a free-form CRM stage name; send all stages including the initial lead stage; `event_time` Unix seconds, up to 7 days old and after lead creation; `action_source` = `system_generated`; `custom_data.lead_event_source` = name of the CRM (for example `Salesforce`); `custom_data.event_source` = `crm`. `user_data` needs at least one identifier. `lead_id` (15 to 17 digits, from the `leadgen_id` webhook field) has highest priority and must be valid or the event is rejected; also highest priority are click ID and hashed email; hashed phone is high; other hashed fields are medium.
- Eligibility (conversion-leads page and FAQ): at least 200 leads per month, target stage reached within 28 days of lead generation, target stage conversion rate roughly 1% to 40%, continually send at least 7 days of data, and upload events for all leads.
- Offline/in-store events (separate use): `action_source=physical_store`, upload within 62 days, dataset must be consolidated. Legacy `upload_tag` still supported.
- Do not use the Conversion Leads spec for events unrelated to that optimization.

## 10. Business messaging

`action_source=business_messaging` plus `messaging_channel` (`messenger`, `whatsapp`, `instagram` in samples). Messenger identifiers in `user_data`: `page_id`, `page_scoped_user_id` (PSID). WhatsApp: `whatsapp_business_account_id` and `ctwa_clid` (send whenever available; it matches more reliably than hashed data). Instagram: `instagram_business_account_id`, `ig_sid`. The guide is written for Business Messaging Partners with extra permissions and API tier; applicability to a direct CRM is unverified. Sample event includes `Purchase` with `currency` and `value`.

## 11. Errors, rate limits, retries

- Responses are minimal: 2xx on valid payload, 4xx with minimal detail on invalid. Specific error code tables were not on the pages read (unverified); consult Graph API error reference.
- No specific CAPI rate limit; calls count as Marketing API calls, excluded from Graph API throttling. Only stated limit: 1,000 events per request. Marketing API rate limiting still applies (see its page, not read).
- Retry guidance: retry on non-client errors (timeouts). Recommended request timeout 1,500 ms; most responses under 600 ms. Always send `event_id` so retried batches do not double count. Do not retry a 4xx without fixing the payload. Backoff intervals are not specified (unverified); use exponential backoff.
- Entire request fails if any `event_time` is older than 7 days.

## 12. Privacy, consent, sensitive data

- Limited Data Use (LDU) via `data_processing_options: ["LDU"]` with country and state, for the US states listed on the data-processing-options page (California, Colorado, Connecticut, Delaware, Florida, Montana, Nebraska, New Hampshire, New Jersey, Oregon, Texas, Minnesota, Maryland, Rhode Island, with effective dates). It must be proactively enabled and may reduce performance.
- Events Manager shows events "discarded due to consent controls and other policies", so consent signals are enforced on Meta's side. The exact consent parameters (for example GDPR consent mode or a consent field in CAPI) were not found in the pages read: **unverified**. Obtain lawful consent before sending, honor opt-outs, and do not send events for users who declined.
- Meta's Business Tools Terms, sensitive-category restrictions (health, finance, and others) and special-category policies are **not covered** in the CAPI pages read, so no rule is asserted here. Treat health, financial, and other sensitive data as unsafe by default. Do not send diagnoses, conditions, or financial status in `event_name` or `custom_data`, and verify against Meta's Business Tools Terms and sensitive-data policy before launch.
- Hash only what the docs say; never log raw PII or the access token.

## 13. CRM lifecycle to Meta event mapping (suggestion, not official)

| CRM event | Suggested Meta event | action_source | Caveats |
|---|---|---|---|
| Contact created (any record) | `Contact` or custom `CRM_Contact_Created` | `system_generated` or `website` | Low value; avoid flooding optimization. Use custom name if it is not a customer-initiated contact. |
| Lead created (form/website) | `Lead` | `website` (with browser `event_id` dedupe) | If from Lead Ads, also send `lead_id` via Conversion Leads flow instead; do not double count. |
| Lead from Meta Instant Form | CRM stage name (free-form), initial stage | `system_generated`, `custom_data.event_source=crm`, `lead_event_source` | Needs `lead_id`; follows Conversion Leads rules (200 leads/month, 28-day window). |
| Lead qualified | Custom event, for example `QualifiedLead`, or a CRM stage in Conversion Leads | `system_generated` | Send all prior stages. A standard event with a different meaning would pollute reporting. |
| Appointment scheduled | `Schedule` | `phone_call`, `chat`, `website` or `system_generated` per channel | Pick the real channel; action_source must be accurate. |
| Purchase completed | `Purchase` | `website`, `physical_store`, `phone_call`, or `system_generated` | Requires `value` and `currency`; use order ID as `event_id` and `order_id`; offline within 62 days, others within 7 days. |
| Message started | `Contact` (or custom) with `business_messaging` | `business_messaging` + `messaging_channel` | Needs `ctwa_clid`/PSID/IGSID and messaging permissions; the exact messaging event name list is unverified. |

## 14. Gaps

Not found or not read: HTTP error code tables, Setup Quality API details, GDPR consent fields, Meta Business Tools Terms/sensitive-category policy, `opt_out` semantics, full `messaging_channel` enum, `madid` hashing, per-standard-event required parameters, token expiry. Verify these before implementation.

## Errata from citation spot-check (2026-11-13)
Endpoint, 1,000-event limit, 7-day event_time, action_source values, hashing rules, fbc format, 48-hour dedup window, test_event_code and CRM/Conversion Leads fields were confirmed against official pages. The 1.5 s timeout and sub-600 ms figures in the retry section are not in the official pages read; treat them as unverified and design retry with conservative defaults. See `docs/research/citation-spot-check.md`.
