#!/usr/bin/env node
/**
 * verify-static.mjs —— 静态页不变量校验（2026-09-13 新增）
 *
 * 为什么需要：平台有 9 个静态页，其中 wake.html 承担"启动过渡页"（有 5 个 id 被内联 JS 依赖），
 * 而"去平台痕迹"（用户可见面不得出现 dsh-users-platform）是个**容易回归**的约束 ——
 * 新人加个页面忘了改名就会漏出去。把它变成 CI 可跑的判据。
 *
 * 用法：node scripts/verify-static.mjs        退出码 0=全绿 / 1=有违规
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'web')
const BANNED = 'dsh-users-platform'          // 用户可见面不得出现的平台内部名
const WAKE_IDS = ['spin', 'step', 'acts', 'retry', 'note']   // wake.html 内联 JS 依赖的 id

let bad = 0
const pages = readdirSync(WEB).filter((f) => f.endsWith('.html'))
console.log('=== 静态页不变量（' + pages.length + ' 页）===')

for (const f of pages) {
  const s = readFileSync(join(WEB, f), 'utf8')
  const problems = []
  const title = /<title>([^<]*)<\/title>/.exec(s)
  if (!title || title[1].trim() === '') problems.push('缺 <title> 或为空')
  else if (title[1].includes(BANNED)) problems.push('title 含内部平台名: ' + title[1])
  if (s.includes(BANNED)) problems.push('页面正文含内部平台名（去痕迹约束）')

  if (f === 'wake.html') {
    for (const id of WAKE_IDS) {
      if (!new RegExp('id="' + id + '"').test(s)) problems.push('缺 id="' + id + '"（内联 JS 依赖）')
    }
    if (!s.includes('instance_circuit_open')) problems.push('缺的熔断提示分支')
  }

  if (problems.length) { bad++; console.log('  ✗ ' + f + '：' + problems.join('；')) }
  else console.log('  ✓ ' + f + (title ? '（title=' + title[1] + '）' : ''))
}

// 内联 <script> 必须能被 JS 解析（2026-09-13 事故：脚本语法错误 = 静默失效）
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const tmp = mkdtempSync(join(tmpdir(), 'vstatic-'))
for (const f of pages) {
  const s = readFileSync(join(WEB, f), 'utf8')
  const blocks = [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  blocks.forEach((code, i) => {
    const file = join(tmp, f.replace(/\W/g, '_') + '.' + i + '.js')
    writeFileSync(file, code)
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); console.log('  ✓ ' + f + ' 内联脚本#' + i + ' 语法通过') }
    catch (e) { bad++; console.log('  ✗ ' + f + ' 内联脚本#' + i + ' **语法失败**：' + String(e.stderr || e).split('\n').slice(0, 2).join(' ')) }
  })
}

// CSS/JS 资源也要过一遍去痕迹约束
for (const f of readdirSync(WEB).filter((f) => /\.(css|js)$/.test(f))) {
  const s = readFileSync(join(WEB, f), 'utf8')
  if (s.includes(BANNED)) { bad++; console.log('  ✗ ' + f + '：含内部平台名') }
  else console.log('  ✓ ' + f)
}

console.log(bad ? '结论：' + bad + ' 项不合格 ❌' : '结论：全部合格 ✅')
process.exit(bad ? 1 : 0)
