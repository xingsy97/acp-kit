import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'ACP Kit',
  description:
    'ACP Kit is a runtime for building applications on top of the Agent Client Protocol.',
  lang: 'en-US',
  base: '/acp-kit/',
  appearance: true,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Doc', link: '/getting-started' },
      { text: 'GitHub', link: 'https://github.com/AcpKit/acp-kit' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Home', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'API Overview', link: '/api-overview' },
          { text: 'Supported Agents', link: '/agents' },
          { text: 'SDK vs Runtime', link: '/acp-sdk-vs-runtime' }
        ]
      },
      {
        text: 'Design Notes',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Package Plan', link: '/package-plan' },
          { text: 'Migration Plan', link: '/migration-plan' }
        ]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/AcpKit/acp-kit' }],
    search: {
      provider: 'local'
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 ACP Kit contributors'
    }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/acp-kit/logo.svg' }],
    ['link', { rel: 'alternate icon', type: 'image/png', href: '/acp-kit/logo.svg' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'ACP Kit' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'ACP Kit - Runtime for Agent Client Protocol applications'
      }
    ],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Launch ACP agents, manage auth and sessions, and consume normalized events with ACP Kit.'
      }
    ],
    ['meta', { property: 'og:image', content: '/acp-kit/og.svg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'ACP Kit' }],
    [
      'meta',
      {
        name: 'twitter:description',
        content:
          'A Node.js runtime for ACP products with built-in process lifecycle, auth orchestration, and event normalization.'
      }
    ]
  ],
  sitemap: {
    hostname: 'https://acpkit.github.io/acp-kit/'
  }
});
