// Single source of truth for channel plugin IDs.
export const CHANNEL_PLUGIN_IDS = {
  discord: 'discord@claude-plugins-official',
} as const

export type ChannelPluginId = (typeof CHANNEL_PLUGIN_IDS)[keyof typeof CHANNEL_PLUGIN_IDS]
