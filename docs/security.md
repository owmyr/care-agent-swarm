# Security, HIPAA Compliance & Audit Architecture

This document specifies the security controls, healthcare compliance standards, data protection mechanisms, and threat model implemented across the **Multi-Agent Swarm AI Orchestration Layer**.

---

## 1. Healthcare Regulatory Framework (HIPAA & CMS)

Residential elderly care facilities and healthcare CRM platforms operate as **Covered Entities** (or Business Associates) under the Health Insurance Portability and Accountability Act (**HIPAA**). The system processes **Protected Health Information (PHI)** across resident intake and clinical incident management.

The architecture is built to fulfill:
- **HIPAA Privacy Rule (45 CFR § 164.514)**: De-identification and Safe Harbor standards for PHI in log output and intermediate storage.
- **HIPAA Security Rule (45 CFR § 164.312(b))**: Audit controls requiring hardware, software, and procedural mechanisms that record and examine activity in information systems containing or using Electronic Protected Health Information (ePHI).
- **State Care Licensing Regulations** (e.g., California Title 22, Texas Administrative Code Title 26): Mandatory incident classification, rapid state reporting timeframes, and audit record retention.

---

## 2. Four-Layer PHI Redaction Engine

Logging prompts and model responses is critical for operational monitoring, but unredacted LLM payloads frequently leak PHI into centralized log aggregators (Datadog, CloudWatch, OpenTelemetry). 

To prevent ePHI leakage, `src/harness/logger.ts` implements a deterministic **Four-Layer Redaction Pipeline** applied before any log record is committed:

```
Raw Payload (Prompt / Output)
             │
             ▼
   [ Layer 1: JSON Tree Traversal ] ──► Recursively redacts keys in structured JSON
             │
             ▼
   [ Layer 2: Fenced Block Sanitizer ] ─► Identifies & sanitizes markdown / code fences
             │
             ▼
   [ Layer 3: Key-Value Colon Scanner ] ─► Scrubs "Field: Value" clinical patterns
             │
             ▼
   [ Layer 4: Format Regex Scrubber ] ──► Pattern-matches SSN, MRN, phone, DOB, email
             │
             ▼
   Safe Redacted Payload -> Pino JSON Output
```

### Layer 1: Structured Object / JSON Tree Traversal
When a payload contains serialized or native JSON objects, the engine recursively traverses object trees. Any key matching the sensitive fields dictionary (e.g., `ssn`, `dob`, `dateOfBirth`, `diagnosis`, `medications`, `mrn`, `apiKey`, `token`) has its value replaced with `[REDACTED]`.

### Layer 2: Fenced Block Sanitizer
Prompts frequently pass clinical documents inside fenced blocks (e.g. `"""..."""` or ````...````). The parser isolates delimited sections and runs contextual key-value redaction over internal blocks.

### Layer 3: Colon-Separated Key-Value Scanner
Unstructured nursing notes frequently write freeform patient identifiers like `DOB: 1948-03-12` or `Medications: Lisinopril 10mg, Metformin 500mg`. Layer 3 isolates colon-separated pairs matching known PHI attributes and masks the following tokens.

### Layer 4: High-Precision Regex Format Scrubber
Regardless of framing or key names, raw strings are scanned for canonical identity formats:
- **US Social Security Numbers (SSN)**: `\b\d{3}-\d{2}-\d{4}\b`
- **Phone Numbers**: standard US 10-digit and dashed patterns
- **Email Addresses**: RFC 5322 compliant regex
- **Standard Dates of Birth**: `YYYY-MM-DD` and `MM/DD/YYYY` forms when flagged in clinical context.

### Metadata-First Logging Policy
By default, `HARNESS_LOG_CONTENT=false`. The harness emits **metadata-only telemetry**:
```json
{
  "level": 30,
  "time": 1789743439123,
  "name": "care-agent-swarm",
  "traceId": "6d6626bd-3823-463d-928f-53a5a6579da7",
  "model": "claude-sonnet-4-5",
  "attempt": 0,
  "requestId": "req_01ABC...",
  "durationMs": 420,
  "inputTokens": 512,
  "outputTokens": 128,
  "hasOutputSchema": true,
  "promptHash": "6e754915cf4b",
  "msg": "llm_call_success"
}
```
Only when explicitly configured (`logContent: true` or `HARNESS_LOG_CONTENT=true`) does the logger emit prompt and output payloads, which are strictly passed through the four-layer redaction pipeline.

---

## 3. Regulatory Audit Trail (45 CFR § 164.312(b))

Every execution of an incident reporting workflow automatically generates an immutable, structured **Audit Trail** conforming to `IncidentAuditTrailSchema` (`src/incident/schemas.ts`).

### Audit Trail Fields
- `incidentId`: Unique incident identifier.
- `traceId`: UUID linking the workflow execution to distributed logs and LLM API requests.
- `timestamp`: ISO-8601 UTC timestamp of execution.
- `classification`: Initial LLM classification with confidence score and detected incident type.
- `regulatoryRoute`: Deterministic regulatory path assigned based on incident type and severity.
- `validationHistory`: Array recording every validation pass:
  - `iteration`: Iteration index (1..maxIterations).
  - `timestamp`: Exact evaluation time.
  - `missingFields`: List of required fields missing during that pass.
  - `inferredFields`: Fields extracted from clinical notes during that pass.
- `loopGuardTriggered`: Boolean indicating whether the iteration cap was reached.
- `humanEscalationRequired`: Boolean flag requiring human clinical supervisor signoff.
- `escalationReason`: Explicit rationale when human handoff is invoked.
- `errors`: Array of contained operational warnings or failures.

Because validation is performed against deterministic rule tables (`REQUIRED_FIELDS_BY_TYPE`), the audit trail is 100% reproducible and verifiable during compliance audits.

---

## 4. Threat Modeling & Mitigation Matrix

| Threat | Attack Vector | Architectural Mitigation |
|---|---|---|
| **Prompt Injection** | Malicious text in raw clinical notes instructing the LLM to ignore instructions or leak prompts. | **Zod Schema Boundary**: The harness enforces strict structured JSON schemas. Injected prompt instructions cannot alter the JSON schema contract; unrecognized keys are stripped. |
| **PHI Leakage to Observability** | Raw patient notes, medical records, or medication lists written to application log streams. | **Four-Layer Redaction Pipeline**: Built-in Pino redaction + regex scrubbers + metadata-first logging defaults (`HARNESS_LOG_CONTENT=false`). |
| **Credential Exfiltration** | Accidental commit or exposure of `ANTHROPIC_API_KEY`. | **Zero-Storage Design**: Keys are read strictly from `process.env`. `.env` is gitignored; `.env.example` contains no secrets. Harness constructors never require hardcoded keys. |
| **Denial of Service / Cost Exhaustion** | Flooding system with requests or triggering infinite LLM infer loops. | **Multi-Tier Protection**: Circuit breaker trips after 5 consecutive failures; hard `maxIterations: 3` loop guard halts execution; per-call timeouts abort stalled streams. |
| **Cascading Multi-Agent Failure** | A single sub-agent outage crashing an entire intake pipeline. | **Promise.allSettled Isolation**: Orchestrator isolates failing sub-agents, flags them as `incomplete`, and produces a usable partial summary. |
