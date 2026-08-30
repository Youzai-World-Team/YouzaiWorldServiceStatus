<script setup lang="ts">
const year = new Date().getFullYear()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <img src="https://assets.mcyzw.top/images/youzaiworldlight.webp" alt="悠哉世界">
        <p>一个充满创意与冒险的 Minecraft 服务器。</p>
      </div>

      <div class="footer-links" aria-label="页脚链接">
        <a href="https://mcyzw.top">返回官网</a>
        <a href="https://mcyzw.top/download">下载中心</a>
        <a href="https://mcyzw.top/tutorial">教程中心</a>
        <a href="https://github.com/Youzai-World-Team" target="_blank" rel="noreferrer">GitHub</a>
      </div>

      <div class="footer-cloudflare">
        <img src="https://assets.mcyzw.top/images/cloudflare.svg" alt="Cloudflare">
        <span>由 Cloudflare 提供安全防护</span>
      </div>
    </div>

    <div class="footer-bottom">
      <span>Copyright &copy; {{ year }} Youzai World Team</span>
      <a href="https://icp.gov.moe/?keyword=20256020" target="_blank" rel="noreferrer">萌 ICP 备 20256020 号</a>
    </div>
  </footer>
</template>

