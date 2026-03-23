// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss'],
  ssr: false,
  nitro: {
    preset: 'static',
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'yaaia — Yet Another AI Agent',
      meta: [
        { charset: 'utf-8' },
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1',
        },
        {
          name: 'description',
          content:
            'YAAIA: event-driven agent runs, unified buses, Telegram as user, contacts & trust, VM execution, conversation-as-code. GPLv3.',
        },
      ],
      link: [{ rel: 'icon', type: 'image/png', href: '/icon.png' }],
    },
  },
})
