# Product
<!-- impeccable:product-schema 1 -->
## Platform
adaptive-ecosystem: a responsive web app (this scope) plus a separate React Native (Expo) Android/iOS app. Mobile design is a separate scope; the web app targets desktop first and must work at 375, 768 and 1440 px.

## Stack
Next.js (App Router) + Tailwind CSS v4 + Radix primitives in a pnpm/Turborepo monorepo; shared Hono API. Chosen in Phase 0 (`docs/research/technology-decisions.md`) and confirmed by the user.

## Users
Now: one owner-operator answering customer DMs from their own Facebook Page and Instagram professional account and tracking leads. Later: small teams (agents, admins) at businesses that sell through social channels, working in the inbox all day, mostly on mobile for replies and on desktop for configuration.

## Product Purpose
A social CRM: unified inbox, contacts, leads and pipeline, with Meta (Messenger, Instagram, Lead Ads, Conversions API) first and automation and AI under human control. Success is a user who trusts the inbox and the pipeline enough to stop juggling native apps.

## Positioning
Honest, reliable social-channel plumbing: shows channel health and delivery state truthfully (for example "delivery unconfirmed" rather than pretending), keeps customers' data private by default, and treats AI and tracking as opt-in. Priced and scoped for small teams, not enterprise.

## Constraints
- Light-first theme, soft neutral canvas, white surfaces, subtle borders, deep charcoal text, indigo/blue-violet accent, minimal shadows, no gradients or glassmorphism (user decision 2026-11-13). Dark mode supported architecturally, not prioritized.
- Design references (do not clone): Attio, Linear, Stripe Dashboard, Intercom.
- Every control works; unavailable features are shown as unavailable with a reason, never as dead buttons.
- Realistic CRM content, never lorem ipsum.
- WCAG 2.2 AA; keyboard operable; permission-aware (role-based navigation).

## Voice
Plain, precise, calm. Controls name their action. Errors name the problem and the recovery.
