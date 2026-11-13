// OpenCodex owns authentication in server mode. Attestation/assertions belong
// to the caller's account too; keep routing/turn metadata for upstream isolation.
export const clientAuthHeaders = Object.freeze([
  'authorization','chatgpt-account-id','x-api-key','api-key',
  'openai-organization','openai-project','cookie','cookie2',
  'x-oai-attestation','x-openai-agent-assertion',
]);
