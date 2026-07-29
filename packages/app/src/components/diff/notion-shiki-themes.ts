/**
 * Notion-inspired Shiki themes for chat Markdown code blocks.
 * Token colors match docs/design-mock/chat-markdown-notion.html.
 */

import type { ThemeRegistration } from 'shiki';

export const NOTION_LIGHT_THEME_NAME = 'notion-light' as const;
export const NOTION_DARK_THEME_NAME = 'notion-dark' as const;

/** Design tokens from chat-markdown-notion.html (.t-light) */
const light = {
  bg: '#F7F6F3',
  ink: '#37352F',
  mute: '#9B9A97',
  kw: '#0070f3',
  str: '#0F7B6C',
  key: '#6940A5',
  bool: '#CB912F',
  comment: '#9B9A97',
} as const;

/** Design tokens from chat-markdown-notion.html (.t-dark) */
const dark = {
  bg: '#202020',
  ink: 'rgba(255, 255, 255, 0.86)',
  mute: 'rgba(255, 255, 255, 0.36)',
  kw: '#6DB3F8',
  str: '#4DAB9A',
  key: '#B088F5',
  bool: '#E0B45A',
  comment: 'rgba(255, 255, 255, 0.36)',
} as const;

function notionTokenColors(c: {
  ink: string;
  mute: string;
  kw: string;
  str: string;
  key: string;
  bool: string;
  comment: string;
}): ThemeRegistration['tokenColors'] {
  return [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: c.comment, fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.operator.new',
        'storage',
        'storage.type',
        'storage.modifier',
        'constant.language',
      ],
      settings: { foreground: c.kw, fontStyle: 'bold' },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'string.regexp',
        'constant.other.symbol',
        'markup.inline.raw',
      ],
      settings: { foreground: c.str },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call',
        'variable.function',
      ],
      settings: { foreground: c.key },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language.boolean',
        'constant.language.null',
        'constant.language.undefined',
        'support.constant',
      ],
      settings: { foreground: c.bool },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.other.inherited-class',
      ],
      settings: { foreground: c.key },
    },
    {
      scope: [
        'variable',
        'variable.other',
        'variable.parameter',
        'meta.definition.variable',
        'support.variable',
      ],
      settings: { foreground: c.ink },
    },
    {
      scope: [
        'meta.object-literal.key',
        'support.type.property-name',
        'entity.name.tag',
        'entity.other.attribute-name',
      ],
      settings: { foreground: c.key },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator'],
      settings: { foreground: c.mute },
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: '#eb5757' },
    },
  ];
}

export const notionLightTheme: ThemeRegistration = {
  name: NOTION_LIGHT_THEME_NAME,
  type: 'light',
  colors: {
    'editor.background': light.bg,
    'editor.foreground': light.ink,
  },
  tokenColors: notionTokenColors(light),
};

export const notionDarkTheme: ThemeRegistration = {
  name: NOTION_DARK_THEME_NAME,
  type: 'dark',
  colors: {
    'editor.background': dark.bg,
    'editor.foreground': dark.ink,
  },
  tokenColors: notionTokenColors(dark),
};
