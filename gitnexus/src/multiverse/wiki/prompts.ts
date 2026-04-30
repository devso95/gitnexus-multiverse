/**
 * Multiverse Wiki Prompts — instructions for LLM to generate meaningful service docs
 *
 * Designed for AI retrieval: structured, factual, grounded in graph data.
 */

export const SERVICE_OVERVIEW_SYSTEM = `You are a technical documentation writer for microservice architectures.
Write clear, factual documentation grounded ONLY in the provided data.
Do NOT invent endpoints, topics, or service names not present in the data.

CRITICAL RULES:
- Use EXACT full paths from the data. Never shorten or remove path prefixes.
- If data says "/api/v1/ordering/workflows/{workflowCode}", write exactly that.
Output markdown directly — no meta-commentary like "Here's the documentation".
Write for developers and AI agents who need to quickly understand what this service does.`;

export const SERVICE_OVERVIEW_PROMPT = `Write a concise overview document for the **{{SERVICE_NAME}}** microservice.

## Data

- Service ID: {{SERVICE_ID}}
- Repo: {{REPO_PROJECT}}/{{REPO_SLUG}} (branch: {{REPO_BRANCH}})
- Type: {{SERVICE_TYPE}}

### API Endpoints ({{ROUTE_COUNT}})
{{ROUTES_SUMMARY}}

### Message Listeners ({{LISTENER_COUNT}})
{{LISTENERS_SUMMARY}}

### Business Capabilities
{{BUSINESS_GROUPS}}

### Upstream Services (call this service)
{{UPSTREAM}}

### Downstream Services (this service calls)
{{DOWNSTREAM}}

### Library Dependencies
{{LIB_DEPS}}

### Unresolved Sinks ({{UNRESOLVED_COUNT}})
{{UNRESOLVED_SUMMARY}}

---

Write a service overview covering:
1. **Purpose** — what this service does (infer from endpoint paths, controller names, topic names)
2. **Key Capabilities** — group by business domain, reference actual endpoints/topics
3. **Integration Points** — how it connects to other services (HTTP, Kafka, libraries)
4. **Data Flow** — describe the main flows through this service
5. **Attention Items** — unresolved sinks, missing links, potential risks

Keep it concise. Use tables for endpoint/channel listings. Use bullet points for flows.`;

export const API_ENDPOINTS_SYSTEM = `You are a technical API documentation writer.
Document HTTP endpoints grounded ONLY in the provided route data.
Group by business domain/controller. For each endpoint, explain its likely purpose based on the path and method.

CRITICAL RULES:
- Use the EXACT full paths from the data. Do NOT shorten, truncate, or remove path prefixes.
- If the data says path is "/api/v1/ordering/workflows/{workflowCode}", write exactly that — not "/{workflowCode}".
- Every path in your output MUST match a path from the input data verbatim.
Output markdown directly.`;

export const API_ENDPOINTS_PROMPT = `Document the API endpoints for **{{SERVICE_NAME}}**.

## Routes by Controller
{{ROUTES_BY_CONTROLLER}}

## Cross-Service Callers
{{CALLERS}}

---

For each controller group:
1. Brief description of what this controller handles (infer from paths)
2. Table of endpoints with method, path, and inferred purpose
3. Note which endpoints are called by other services (impact if changed)`;

export const MESSAGING_SYSTEM = `You are a technical documentation writer for event-driven architectures.
Document messaging channels grounded ONLY in the provided data.
Explain the purpose of each topic/queue based on its name and context.
Output markdown directly.`;

export const MESSAGING_PROMPT = `Document the messaging channels for **{{SERVICE_NAME}}**.

## Kafka Consumers
{{KAFKA_CONSUMERS}}

## Kafka Producers
{{KAFKA_PRODUCERS}}

## Other Channels
{{OTHER_CHANNELS}}

---

For each channel:
1. Infer its business purpose from the topic name
2. Describe the data flow direction (who produces, who consumes)
3. Note cross-service implications`;

export const DEPENDENCIES_SYSTEM = `You are a technical documentation writer for microservice dependency analysis.
Describe cross-service dependencies grounded ONLY in the provided data.
Focus on impact analysis: what breaks if a service goes down.
Output markdown directly.`;

export const DEPENDENCIES_PROMPT = `Document the cross-service dependencies for **{{SERVICE_NAME}}**.

## Upstream (services that call this service)
{{UPSTREAM_DETAIL}}

## Downstream (services this service calls)
{{DOWNSTREAM_DETAIL}}

---

Write:
1. **Dependency summary** — which services are tightly coupled
2. **Impact analysis** — what happens if this service is unavailable (who is affected)
3. **Reverse impact** — what happens if downstream services are unavailable
4. **Communication patterns** — sync (HTTP) vs async (Kafka) breakdown`;

/** Replace {{PLACEHOLDER}} tokens */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
