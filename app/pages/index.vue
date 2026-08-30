<script setup lang="ts">
import {
  Activity,
  Boxes,
  CheckCircle2,
  Clock3,
  CloudOff,
  Cpu,
  Gamepad2,
  Gauge,
  Globe2,
  HardDrive,
  Image,
  Mail,
  MemoryStick,
  RefreshCw,
  Server,
  TriangleAlert,
  Users,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ServiceStatus, StatusSnapshot, StatusTone } from '../../shared/status'

useHead({
  title: '悠哉世界服务状态',
  meta: [
    { name: 'og:title', content: '悠哉世界服务状态' },
    { name: 'og:description', content: '查看悠哉世界各项公共服务、运行节点与 Minecraft 游戏服务的实时状态。' },
  ],
})

const serviceIcons: Record<ServiceStatus['id'], Component> = {
  website: Globe2,
  api: Boxes,
  assets: Image,
  mail: Mail,
}

const statusLabels: Record<StatusTone, string> = {
  operational: '运行正常',
  degraded: '部分异常',
  outage: '服务中断',
  unknown: '状态未知',
}

const { data: snapshot, pending, error } = await useFetch<StatusSnapshot>('/api/status', {
  key: 'service-status',
})

const refreshing = ref(false)
const requestError = ref('')
let refreshTimer: number | undefined

const overallIcon = computed(() => {
  if (snapshot.value?.overall === 'operational') return CheckCircle2
  if (snapshot.value?.overall === 'outage') return CloudOff
  return TriangleAlert
})

const overallTitle = computed(() => {
  if (!snapshot.value) return '正在获取服务状态'
  if (snapshot.value.overall === 'operational') return '所有服务运行正常'
  if (snapshot.value.overall === 'outage') return '多项服务当前不可用'
  return '部分服务运行异常'
})

const overallDescription = computed(() => {
  if (!snapshot.value) return '状态数据正在从各监控源汇总。'
  const abnormal = [
    ...snapshot.value.services.filter((service) => service.status !== 'operational').map((service) => service.name),
    ...(snapshot.value.node.status !== 'operational' ? ['运行节点'] : []),
    ...(snapshot.value.minecraft.status !== 'operational' ? ['Minecraft 游戏服务'] : []),
  ]
  return abnormal.length ? `受影响项目：${abnormal.join('、')}` : '官网、接口、资源、邮件与游戏服务均可正常访问。'
})

const availability = computed(() => {
  const history = snapshot.value?.history || []
  if (!history.length) return null
  const online = history.filter((point) => point.status === 'online').length
  return online / history.length * 100
})

const emptyHistoryPoints = computed(() => Math.max(96 - (snapshot.value?.history.length || 0), 0))

function toneLabel(tone: StatusTone): string {
  return statusLabels[tone]
}

function formatTime(timestamp?: number | null): string {
  if (!timestamp) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))
}

function formatLatency(latency?: number | null): string {
  return latency === null || latency === undefined ? '-' : `${latency} ms`
}

function formatUsage(value?: number | null): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(1)}%`
}

function historyTitle(time: number, status: 'online' | 'offline'): string {
  return `${formatTime(time)} · ${status === 'online' ? '在线' : '离线'}`
}

async function loadStatus() {
  if (refreshing.value) return
  refreshing.value = true
  requestError.value = ''
  try {
    snapshot.value = await $fetch<StatusSnapshot>('/api/status')
  } catch {
    requestError.value = '状态数据刷新失败，当前继续显示最近一次结果。'
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  refreshTimer = window.setInterval(() => loadStatus(), snapshot.value?.refreshAfterMs || 60_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div>
    <section class="status-hero">
      <div class="hero-overlay" />
      <div class="hero-inner">
        <p class="hero-kicker">Youzai World Status</p>
        <h1>悠哉世界服务状态</h1>
        <p>公共服务、运行节点与 Minecraft 游戏服务的实时运行情况</p>
      </div>
    </section>

    <section class="overall-band" :class="`tone-${snapshot?.overall || 'unknown'}`" aria-live="polite">
      <div class="content-container overall-inner">
        <component :is="overallIcon" :size="30" stroke-width="2" aria-hidden="true" />
        <div class="overall-copy">
          <h2>{{ overallTitle }}</h2>
          <p>{{ overallDescription }}</p>
        </div>
        <div class="overall-meta">
          <span><Clock3 :size="16" aria-hidden="true" />{{ formatTime(snapshot?.generatedAt) }}</span>
          <button
            class="icon-button"
            type="button"
            title="刷新状态"
            aria-label="刷新状态"
            :disabled="refreshing"
            @click="loadStatus"
          >
            <RefreshCw :size="20" :class="{ spinning: refreshing }" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>

    <div v-if="requestError" class="content-container transient-error" role="status">
      <TriangleAlert :size="18" aria-hidden="true" />
      {{ requestError }}
    </div>

    <div v-if="pending && !snapshot" class="content-container loading-state" aria-live="polite">
      <RefreshCw :size="26" class="spinning" aria-hidden="true" />
      <span>正在汇总服务状态...</span>
    </div>

    <div v-else-if="error && !snapshot" class="content-container load-error">
      <CloudOff :size="38" aria-hidden="true" />
      <h2>暂时无法获取状态数据</h2>
      <p>状态 Worker 当前未能完成检测，请稍后重试。</p>
      <button class="command-button command-button--primary" type="button" @click="loadStatus">
        <RefreshCw :size="18" aria-hidden="true" />
        重新检测
      </button>
    </div>

    <template v-else-if="snapshot">
      <section class="page-section services-section">
        <div class="content-container">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Public Services</p>
              <h2>公共服务</h2>
            </div>
            <span>{{ snapshot.services.length }} 项检测</span>
          </div>

          <div class="service-grid">
            <article v-for="service in snapshot.services" :key="service.id" class="service-card">
              <div class="service-icon" :class="`tone-${service.status}`">
                <component :is="serviceIcons[service.id]" :size="24" aria-hidden="true" />
              </div>
              <div class="service-main">
                <h3>{{ service.name }}</h3>
                <p>{{ service.description }}</p>
              </div>
              <div class="service-status">
                <span class="status-badge" :class="`tone-${service.status}`">
                  <i />{{ toneLabel(service.status) }}
                </span>
                <span>{{ formatLatency(service.latencyMs) }}</span>
              </div>
              <div class="service-detail">
                <span>{{ service.message }}</span>
                <span>HTTP {{ service.httpStatus || '-' }}</span>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section class="page-section infrastructure-section">
        <div class="content-container">
          <div class="section-heading">
            <div>
              <p class="section-kicker">Infrastructure</p>
              <h2>节点与游戏服务</h2>
            </div>
          </div>

          <div class="infrastructure-grid">
            <article class="detail-card">
              <div class="detail-card-header">
                <div class="detail-title">
                  <span class="detail-icon"><Server :size="23" aria-hidden="true" /></span>
                  <div>
                    <h3>运行节点</h3>
                    <p>{{ snapshot.node.name }}</p>
                  </div>
                </div>
                <span class="status-badge" :class="`tone-${snapshot.node.status}`">
                  <i />{{ toneLabel(snapshot.node.status) }}
                </span>
              </div>

              <div class="resource-metric">
                <div class="metric-label">
                  <span><Cpu :size="17" aria-hidden="true" />CPU 使用率</span>
                  <strong>{{ formatUsage(snapshot.node.cpuUsage) }}</strong>
                </div>
                <div class="metric-track" role="progressbar" aria-label="CPU 使用率" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="snapshot.node.cpuUsage || 0">
                  <span :style="{ width: `${snapshot.node.cpuUsage || 0}%` }" />
                </div>
              </div>

              <div class="resource-metric">
                <div class="metric-label">
                  <span><MemoryStick :size="17" aria-hidden="true" />内存使用率</span>
                  <strong>{{ formatUsage(snapshot.node.memoryUsage) }}</strong>
                </div>
                <div class="metric-track" role="progressbar" aria-label="内存使用率" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="snapshot.node.memoryUsage || 0">
                  <span :style="{ width: `${snapshot.node.memoryUsage || 0}%` }" />
                </div>
              </div>

              <dl class="detail-list">
                <div>
                  <dt><HardDrive :size="17" aria-hidden="true" />系统类型</dt>
                  <dd>{{ snapshot.node.systemType || '-' }}</dd>
                </div>
                <div>
                  <dt><Clock3 :size="17" aria-hidden="true" />节点上报</dt>
                  <dd>{{ formatTime(snapshot.node.timestamp) }}</dd>
                </div>
              </dl>

              <p v-if="snapshot.errors.node" class="source-note tone-outage">{{ snapshot.errors.node }}</p>
            </article>

            <article class="detail-card">
              <div class="detail-card-header">
                <div class="detail-title">
                  <span class="detail-icon"><Gamepad2 :size="23" aria-hidden="true" /></span>
                  <div>
                    <h3>Minecraft 游戏服务</h3>
                    <p>{{ snapshot.minecraft.address }}</p>
                  </div>
                </div>
                <span class="status-badge" :class="`tone-${snapshot.minecraft.status}`">
                  <i />{{ toneLabel(snapshot.minecraft.status) }}
                </span>
              </div>

              <dl class="game-stat-grid">
                <div>
                  <dt><Users :size="18" aria-hidden="true" />在线玩家</dt>
                  <dd>{{ snapshot.minecraft.playersOnline ?? '-' }} / {{ snapshot.minecraft.playersMax ?? '-' }}</dd>
                </div>
                <div>
                  <dt><Gauge :size="18" aria-hidden="true" />连接延迟</dt>
                  <dd>{{ formatLatency(snapshot.minecraft.latencyMs) }}</dd>
                </div>
                <div>
                  <dt><Activity :size="18" aria-hidden="true" />游戏版本</dt>
                  <dd>{{ snapshot.minecraft.version || '-' }}</dd>
                </div>
                <div>
                  <dt><Server :size="18" aria-hidden="true" />协议版本</dt>
                  <dd>{{ snapshot.minecraft.protocol || '-' }}</dd>
                </div>
              </dl>

              <p class="source-note" :class="`tone-${snapshot.minecraft.status}`">{{ snapshot.minecraft.message }}</p>
            </article>
          </div>
        </div>
      </section>

      <section class="page-section history-section">
        <div class="content-container">
          <div class="section-heading history-heading">
            <div>
              <p class="section-kicker">Last 24 Hours</p>
              <h2>游戏节点可用性</h2>
            </div>
            <strong>{{ availability === null ? '-' : `${availability.toFixed(1)}%` }}</strong>
          </div>

          <div v-if="snapshot.history.length" class="history-chart" role="img" :aria-label="`最近 24 小时在线率 ${availability?.toFixed(1)}%`">
            <span v-for="index in emptyHistoryPoints" :key="`empty-${index}`" class="history-segment history-segment--empty" title="无数据" />
            <span
              v-for="point in snapshot.history"
              :key="`${point.time}-${point.status}`"
              class="history-segment"
              :class="`history-segment--${point.status}`"
              :title="historyTitle(point.time, point.status)"
            />
          </div>
          <div v-else class="history-empty">
            <TriangleAlert :size="20" aria-hidden="true" />
            {{ snapshot.errors.history || '暂无历史监控数据' }}
          </div>

          <div class="history-axis" aria-hidden="true">
            <span>24 小时前</span>
            <span>12 小时前</span>
            <span>现在</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
