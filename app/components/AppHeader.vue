<script setup lang="ts">
import { Menu, X } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref } from 'vue'

const menuOpen = ref(false)

function closeMenu() {
  menuOpen.value = false
}

function onEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => document.addEventListener('keydown', onEscape))
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <header class="site-header">
    <div class="nav-container">
      <a class="brand-link" href="https://mcyzw.top" aria-label="悠哉世界官网">
        <img src="https://assets.mcyzw.top/images/uzw-tm.png" alt="悠哉世界">
      </a>

      <nav class="desktop-nav" aria-label="主导航">
        <a href="https://mcyzw.top">官网</a>
        <a href="https://mcyzw.top/download">下载中心</a>
        <a href="https://mcyzw.top/tutorial">教程中心</a>
        <a href="https://mcyzw.top/banlist">处罚记录</a>
        <a class="nav-current" href="/" aria-current="page">服务状态</a>
      </nav>

      <button
        class="menu-button"
        type="button"
        :aria-expanded="menuOpen"
        aria-controls="mobile-navigation"
        :aria-label="menuOpen ? '关闭导航菜单' : '打开导航菜单'"
        @click="menuOpen = !menuOpen"
      >
        <X v-if="menuOpen" :size="24" aria-hidden="true" />
        <Menu v-else :size="24" aria-hidden="true" />
      </button>
    </div>

    <nav v-if="menuOpen" id="mobile-navigation" class="mobile-nav" aria-label="移动端导航">
      <a href="https://mcyzw.top" @click="closeMenu">官网</a>
      <a href="https://mcyzw.top/download" @click="closeMenu">下载中心</a>
      <a href="https://mcyzw.top/tutorial" @click="closeMenu">教程中心</a>
      <a href="https://mcyzw.top/banlist" @click="closeMenu">处罚记录</a>
      <a class="nav-current" href="/" aria-current="page" @click="closeMenu">服务状态</a>
    </nav>
  </header>
</template>

