export {
  LINK_HOVER_CONFIG_KEY,
  DEFAULT_LINK_HOVER_CONFIG,
  normalizeDomainEntry,
  isHostAllowed,
  parseLinkHoverConfig,
  isLinkHoverEnabledForHost,
  addDomainToConfig,
  removeDomainFromConfig,
  type LinkHoverConfig,
} from './config'

export {
  readLinkHoverConfig,
  writeLinkHoverConfig,
  watchLinkHoverConfig,
} from './chrome-storage'
