/**
 * Providers we surface prominently, shared by the settings LLM pane and
 * first-run onboarding so the two cannot drift apart.
 */
export const MAINSTREAM_PROVIDER_IDS = new Set([
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'ollama',
  'alibaba',
  'alibaba-cn',
  'zhipuai',
])

/**
 * The short list offered during onboarding, in display order.
 *
 * Deliberately hardcoded rather than read from the daemon's provider catalog:
 * this screen runs before sign-in, and gating a first-run step on a catalog
 * fetch would leave the user staring at a spinner — or an empty list — for
 * reasons they cannot act on. Anything not here is reachable from Settings.
 *
 * `ollama` is excluded on purpose: it needs no API key, so it does not fit the
 * paste-a-key flow this screen is built around.
 */
export const ONBOARDING_PROVIDERS: { id: string; name: string }[] = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'alibaba', name: '通义千问 Qwen' },
  { id: 'zhipuai', name: '智谱 GLM' },
  { id: 'anthropic', name: 'Anthropic Claude' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google Gemini' },
]
