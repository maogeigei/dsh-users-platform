/**
 * 崩溃退避与熔断策略单测（纯函数，不 spawn 任何进程）。
 * 运行：node --test test/crash-policy.test.mjs（含在 npm test 中）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  backoffDelayMs,
  breakerActive,
  breakerCooldownMs,
  breakerUntil,
  decideCrashAction,
  openBreaker,
  pruneHistory,
} from '../lib/supervisor/crash-policy.js'

const CFG = { baseDelayMs: 1000, maxDelayMs: 30000, windowMs: 600000, maxRestartsInWindow: 5, stableResetMs: 60000 }

test('backoffDelayMs: 指数退避并在上限处封顶', () => {
  assert.equal(backoffDelayMs(0, CFG), 1000)
  assert.equal(backoffDelayMs(1, CFG), 2000)
  assert.equal(backoffDelayMs(2, CFG), 4000)
  assert.equal(backoffDelayMs(3, CFG), 8000)
  assert.equal(backoffDelayMs(4, CFG), 16000)
  assert.equal(backoffDelayMs(5, CFG), 30000, '超过上限应封顶到 maxDelayMs')
  assert.equal(backoffDelayMs(50, CFG), 30000, '极大值也不溢出')
})

test('pruneHistory: 丢弃窗口外的时间戳', () => {
  const now = 1_000_000
  assert.deepEqual(pruneHistory([now - 700_000, now - 100_000, now - 1_000], now, CFG.windowMs), [
    now - 100_000,
    now - 1_000,
  ])
})

test('decideCrashAction: 窗口内未超限 → restart（带退避与尝试号）', () => {
  const now = 1_000_000
  const d = decideCrashAction([now - 5_000], 0, now, CFG)
  assert.equal(d.action, 'restart')
  assert.equal(d.delayMs, 1000)
  assert.equal(d.attempt, 1)
  assert.equal(d.windowRestarts, 2)
})

test('decideCrashAction: 达到窗口上限 → circuit-open（熔断）', () => {
  const now = 1_000_000
  const history = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000] // 恰好 5 次
  const d = decideCrashAction(history, 5, now, CFG)
  assert.equal(d.action, 'circuit-open')
  assert.equal(d.windowRestarts, 5)
})

test('decideCrashAction: 窗口外的历史不计入熔断', () => {
  const now = 1_000_000
  const history = [now - 900_000, now - 800_000, now - 700_000, now - 650_000, now - 610_000] // 全部 > windowMs
  const d = decideCrashAction(history, 5, now, CFG)
  assert.equal(d.action, 'restart', '窗口外的旧崩溃不应触发熔断')
  assert.equal(d.windowRestarts, 1)
})

test('decideCrashAction: 稳定后 streak 归零 → 退避回到 base', () => {
  const now = 2_000_000
  // 历史上有 3 次（窗口内），但 streak=0（已稳定过），退避应回到 baseDelayMs
  const history = [now - 300_000, now - 200_000, now - 100_000]
  const d = decideCrashAction(history, 0, now, CFG)
  assert.equal(d.action, 'restart')
  assert.equal(d.delayMs, 1000)
  assert.equal(d.windowRestarts, 4)
})

test('decideCrashAction: 第 5 次（窗口内已有 4 次）仍允许重启，第 6 次熔断', () => {
  const now = 3_000_000
  const four = [now - 4000, now - 3000, now - 2000, now - 1000]
  const d5 = decideCrashAction(four, 4, now, CFG)
  assert.equal(d5.action, 'restart')
  assert.equal(d5.windowRestarts, 5)
  const five = [...four, now]
  const d6 = decideCrashAction(five, 5, now, CFG)
  assert.equal(d6.action, 'circuit-open')
})

/* ── 熔断冷却（防「崩溃循环可无限重来」）────────────────────────── */

const BCFG = { baseCooldownMs: 600000, maxCooldownMs: 21600000 }

test('breakerCooldownMs: 指数加长并在上限封顶', () => {
  assert.equal(breakerCooldownMs(1, BCFG), 600000)
  assert.equal(breakerCooldownMs(2, BCFG), 1200000)
  assert.equal(breakerCooldownMs(3, BCFG), 2400000)
  assert.equal(breakerCooldownMs(99, BCFG), 21600000)
})

test('openBreaker/breakerActive/breakerUntil: opens 递增、冷却期内 active', () => {
  const t0 = 1_000_000
  const b1 = openBreaker(undefined, t0)
  assert.deepEqual(b1, { openedAt: t0, opens: 1 })
  assert.equal(breakerActive(b1, t0 + 599_999, BCFG), true)
  assert.equal(breakerActive(b1, t0 + 600_000, BCFG), false)
  assert.equal(breakerUntil(b1, BCFG), t0 + 600000)
  const b2 = openBreaker(b1, t0 + 600_000)
  assert.equal(b2.opens, 2)
  assert.equal(breakerUntil(b2, BCFG), t0 + 600_000 + 1_200_000)
  assert.equal(breakerActive(undefined, t0, BCFG), false)
})

test('回归：熔断后冷却期内应拒绝、冷却过后才放行一次预算', () => {
  const now = 5_000_000
  const history = [now - 5000, now - 4000, now - 3000, now - 2000, now - 1000]
  assert.equal(decideCrashAction(history, 5, now, CFG).action, 'circuit-open')
  const b = openBreaker(undefined, now)
  assert.equal(breakerActive(b, now + 1000, BCFG), true)    // 冷却期内 → 拒绝重来
  assert.equal(breakerActive(b, now + 600_000, BCFG), false) // 冷却过后 → 放行一次干净预算
})
