# Admin Panel Feature Inventory

Inventory covers the retired hosted Admin WebApp and Telegram bot in `admin-bot/`,
the current Admin WebApp/API, PostgreSQL schema and operational commands.

| Feature | Legacy panel | Current implementation | API / DB support | Decision | Final status |
|---|---|---|---|---|---|
| Overview | Firebase counters and device state | Basic PostgreSQL counts | PostgreSQL projections | Redesign | Real company/worker/model/party/device/pending/binding counts and recent sync timestamp; explicit load/error/empty states |
| Business scopes | Firebase names/metadata | Scope union and activation policy | `company_batch_settings`, `activation_companies` | Redesign | Existing scopes only; label, sizes, server revision, policy roles/validation/active state |
| Strict / free mode | Not authoritative | Existing policy field in activation UI | Reuses `activation_companies.require_ticket_validation`; migrations 11 and 13 add revision, immutable audit and synchronized-device count | Redesign | Company-scoped confirmed toggle re-signs stale approved device activations through the private admin-bot signer; default strict |
| Activation requests | Legacy Firebase device/key actions | Request lifecycle and signatures | Authenticated approval/reject/revoke and private bot signer | Keep / redesign | Status list, details/events, confirmation, server-side Ed25519; no private keys exposed |
| Devices | Firebase telemetry/flags | Server devices and requests | `server_devices`, activation data | Retire unsupported telemetry | Read-only canonical fields; revocation unavailable without a server command |
| Workers | Owner/company workflows | Roster/payroll projection | Workers, bindings, ticket and adjustment facts | Keep / redesign | Search, server pagination, worker ID identity and read-only payroll |
| Telegram bindings | Phone matching/owner assignment | Inline in roster | `worker_telegram_bindings` | Redesign | Separate paginated read view; no fabricated bindings or impersonation |
| Models | Legacy Firebase views | Not separately exposed | `models`, company sizes/revision | Keep as read-only | Operations/rates and available sizes; no projection writes |
| Parties | Legacy business views | Not separately exposed | `parties`, models | Keep as read-only | Status/context/patta summary/ishSoni/timestamps; no fabricated patta rows |
| Tickets / production | Legacy production views | Not separately exposed | `tickets`, `ticket_entries`; free mode uses nullable `party_record_id` | Redesign | Bounded read list and empty state; free-mode tickets keep canonical ticket identity without inventing a Party row |
| Avans / jarima | Legacy balance actions | Payroll totals only | `worker_adjustments` | Redesign | Read-only fact totals with opening-balance provenance; no historical transaction fiction |
| System health | Legacy service status | No dedicated page | Safe API/PostgreSQL/migration projection | Redesign | API/DB, migration and revision; unavailable bot/backup telemetry is labeled unavailable |
| Audit | Bot/legacy traces | Activation event inspector | Activation events plus immutable strict-mode policy events | Keep reliable evidence | Real persisted events and actor identity; no invented history |
| Owners, Firebase flags, arbitrary keys | Firebase owner queues and arbitrary key actions | Explicitly retired | No authority | Retire | Not ported; activation lifecycle and allowlist remain authoritative |

Worker/model/accounting writes, device revocation, manual binding changes, backup
execution and admin allowlist editing remain unavailable in the WebApp unless an
existing safe server-side command owns them. No browser database access, Firebase
write path or external hosting-provider dependency was added.
