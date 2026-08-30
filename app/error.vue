<script setup lang="ts">
import type { NuxtError } from '#app'
import { ArrowLeft, House } from 'lucide-vue-next'

const props = defineProps<{ error: NuxtError }>()

function goHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <NuxtLayout>
    <section class="error-page">
      <img src="https://assets.mcyzw.top/images/error.webp" alt="页面访问错误">
      <p class="error-code">{{ props.error.statusCode || 500 }}</p>
      <h1>这个页面暂时无法访问</h1>
      <p>{{ props.error.statusMessage || '请稍后重试，或返回服务状态首页。' }}</p>
      <div class="error-actions">
        <button class="command-button command-button--primary" type="button" @click="goHome">
          <House :size="18" aria-hidden="true" />
          返回状态首页
        </button>
        <a class="command-button" href="https://mcyzw.top">
          <ArrowLeft :size="18" aria-hidden="true" />
          返回官网
        </a>
      </div>
    </section>
  </NuxtLayout>
</template>

