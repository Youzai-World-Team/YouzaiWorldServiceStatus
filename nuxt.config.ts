export default defineNuxtConfig({
  compatibilityDate: '2026-08-30',
  devtools: { enabled: false },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: '悠哉世界服务状态',
      meta: [
        { charset: 'UTF-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
        {
          name: 'description',
          content: '悠哉世界官网、API、静态资源、邮件处理器、运行节点与 Minecraft 游戏服务状态。',
        },
        { name: 'theme-color', content: '#345e54' },
      ],
      link: [
        { rel: 'icon', href: 'https://assets.mcyzw.top/images/logocircle.webp' },
        { rel: 'preconnect', href: 'https://assets.mcyzw.top' },
        {
          rel: 'preload',
          as: 'font',
          type: 'font/woff2',
          href: 'https://assets.mcyzw.top/fonts/zkklt2016xdb.woff2',
          crossorigin: '',
        },
      ],
    },
  },

  css: ['~/assets/scss/main.scss'],

  nitro: {
    preset: 'cloudflare_module',
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      '*/5 * * * *': ['status:check'],
    },
  },
})

