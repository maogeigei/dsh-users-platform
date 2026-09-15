// Stand-in for a real `dsh` process used by the smoke tests. It is role-aware
// via DSH_USERS_PLATFORM_ROLE:
//   - main: bind the loopback port and serve a marker page; /crash exits 1.
//   - watchdog: headless; polls the handoff file and records what it "executes".
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const role = process.env.DSH_USERS_PLATFORM_ROLE ?? 'main'
const port = Number(process.env.DSH_USERS_PLATFORM_PORT ?? '3080')
const cwd = process.cwd()

if (role === 'watchdog') {
  // One-shot watchdog: mark it ran, execute any handoff command, then exit.
  const handoffPath = process.env.DSH_USERS_PLATFORM_HANDOFF_PATH
  console.log(`fake-watchdog one-shot running cwd=${cwd}`)
  if (handoffPath !== undefined) {
    writeFileSync(join(dirname(handoffPath), 'watchdog-ran.json'), JSON.stringify({ at: Date.now() }))
  }
  setTimeout(() => {
    let command = null
    if (handoffPath !== undefined && existsSync(handoffPath)) {
      const content = readFileSync(handoffPath, 'utf8').trim()
      if (content !== '') {
        try {
          command = JSON.parse(content).command ?? content
        } catch {
          command = content
        }
        writeFileSync(join(dirname(handoffPath), 'watchdog-executed.json'), JSON.stringify({ command, at: Date.now() }))
        writeFileSync(handoffPath, '')
      }
    }
    console.log(`fake-watchdog done${command ? ` (executed: ${command})` : ''}`)
    process.exit(0)
  }, 300)
} else {
  const server = createServer((req, res) => {
    if (req.url === '/crash') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('crashing')
      setTimeout(() => process.exit(1), 10)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/somewhere' })
      res.end('redirecting')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      `fake-dsh pid=${process.pid} port=${port} cwd=${cwd} url=${req.url} argv=${process.argv.slice(2).join(' ')}`,
    )
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`fake-dsh listening on ${port}`)
    // 真实 dsh 启动后会打印**可直达的带 token URL**，平台就是靠这行取 launch token
    // （正则：/dsh web: http://////127//.0//.0//.1://d+/////?token=([A-Za-z0-9_-]+)/）。
    // 夹具必须照实吐出来，否则平台只能等满 10 s 超时 ⇒ 「登录直达会话」这条链路
    // 在本机测试里**永远测不到**（2026-09-15 T08 S3 实测踩到）。
    console.log(`dsh web: http://127.0.0.1:${port}/?token=FAKE_TOKEN_${process.pid}`)
  })
}
