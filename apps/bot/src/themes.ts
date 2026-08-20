import type { VaporzrTheme } from '@vaporzr/shared';

export const THEMES: VaporzrTheme[] = [
  {
    id: 'vaporzr',
    name: 'Vaporzr',
    accent: '#6a5cff',
    accent2: '#00f0ff',
    glow: 'rgba(106, 92, 255, 0.45)',
    embedColor: 0x6a5cff,
  },
  {
    id: 'neon',
    name: 'Neon Blast',
    accent: '#ff073a',
    accent2: '#1ed6ff',
    glow: 'rgba(255, 0, 184, 0.45)',
    embedColor: 0xff073a,
  },
  {
    id: 'midnight',
    name: 'Midnight Club',
    accent: '#8a7dff',
    accent2: '#60a5fa',
    glow: 'rgba(96, 165, 250, 0.45)',
    embedColor: 0x8a7dff,
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    accent: '#f472b6',
    accent2: '#fb923c',
    glow: 'rgba(244, 114, 182, 0.45)',
    embedColor: 0xf472b6,
  },
  {
    id: 'plasma',
    name: 'Plasma',
    accent: '#22d3ee',
    accent2: '#a78bfa',
    glow: 'rgba(34, 211, 238, 0.4)',
    embedColor: 0x22d3ee,
  },
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    accent: '#a855f7',
    accent2: '#6366f1',
    glow: 'rgba(168, 85, 247, 0.45)',
    embedColor: 0xa855f7,
  },
  {
    id: 'marshmallow',
    name: 'Marshmallow',
    accent: '#f472b6',
    accent2: '#e879f9',
    glow: 'rgba(232, 121, 249, 0.4)',
    embedColor: 0xe879f9,
  },
  {
    id: 'emerald',
    name: 'Emerald City',
    accent: '#34d399',
    accent2: '#22d3ee',
    glow: 'rgba(52, 211, 153, 0.4)',
    embedColor: 0x34d399,
  },
];

export const DEFAULT_THEME: VaporzrTheme = THEMES[0];

export function themeById(id: string): VaporzrTheme | undefined {
  return THEMES.find((t) => t.id === id);
}
