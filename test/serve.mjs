/**
 * 浏览器端验证台（开发用，不随插件发布）。
 *
 * 起一个只服务本插件目录的静态服务器，并打开 test/harness.html：
 * 页面里用与 DSH Web GUI 相同的 DOM 约定（`data-chat-flow-kind` + 一个
 * `white-space: pre-wrap` 的文本容器）复刻几种真实气泡，然后加载 lib/client.js
 * 并 materialize 它，用来在真实浏览器里验证「文本替换 + React 重渲染恢复 +
 * 编辑态跳过 + 混合内容跳过」这几条行为。
 *
 * 运行：node test/serve.mjs   →  http://127.0.0.1:3460/harness.html
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT || 3460)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    const file = join(root, rel)
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`harness: http://127.0.0.1:${port}/test/harness.html\n`)
})
