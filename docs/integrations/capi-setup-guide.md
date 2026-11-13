# Meta Conversions API Setup Guide (draft)

Status: draft from research (2026-11-13). Steps marked "verify" must be confirmed in the live Meta UI during Phase 6b, and screenshots added. Nothing here has been run against Meta.

## What you need
1. A Meta Business portfolio and an Events Manager Dataset (a Pixel is a dataset). A registered company is not stated as a requirement in the docs read; confirm in the UI (verify).
2. A Conversions API access token generated in Events Manager (Settings, Conversions API, Generate access token). Meta creates a system user for it; no App Review is required for this path per the docs read.
3. Your Dataset ID.
4. Optional: a Test Event Code from the Test Events tab.

## In the CRM
1. Open Integrations, Meta Conversions API, Connect Dataset.
2. Paste the Dataset ID and token. The token is encrypted on the server and cannot be viewed again.
3. Click Test connection, then Send test event. Check Events Manager, Test Events for the event.
4. Enable only the event mappings you want. Every mapping is off by default.
5. Confirm your consent basis for each mapping. Events for contacts without recorded consent are skipped when consent is required.

## What the CRM sends
Event name, time, a stable event id, action source, and only the customer fields allowed by the mapping, normalized and SHA-256 hashed where Meta requires it (email, phone, name, gender, date of birth, city, state, ZIP, country; external id hashed by default). IP address, user agent, fbc and fbp are sent unhashed only when they were genuinely captured. Purchase events include value and currency. The CRM never invents identifiers.

## Meaning of "delivered"
The CRM shows that Meta accepted the request. It does not show attribution or a counted conversion.

## Troubleshooting (to complete with real errors)
Invalid token, wrong dataset, events older than 7 days, missing required parameter, rate limit. To be filled in with actual API responses during verification.
