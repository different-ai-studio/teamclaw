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
/**
 * `keyUrl` points at the page that issues the key, not the vendor's homepage.
 * The screen asks for something the user may not have yet, so the link has to
 * land on the console that hands it over — a marketing page makes them hunt.
 */
export const ONBOARDING_PROVIDERS: { id: string; name: string; keyUrl: string }[] = [
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'alibaba', name: '通义千问 Qwen', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
  { id: 'zhipuai', name: '智谱 GLM', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'anthropic', name: 'Anthropic Claude', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', name: 'Google Gemini', keyUrl: 'https://aistudio.google.com/app/apikey' },
]
