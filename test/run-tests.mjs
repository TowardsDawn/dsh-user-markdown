/**
 * dsh-user-markdown 单元测试（无需浏览器 / 无需 DOM）。
 *
 * 做法：用最小 window mock 执行 lib/client.js，拿到插件工厂的返回值，
 * 直接对 `__test` 暴露的 Markdown 渲染器做断言。
 *
 * 运行：node test/run-tests.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const code = readFileSync(clientPath, 'utf8')

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    }
  }
}

// client.js 是纯脚本（无 import/export），可直接用 Function 求值
// eslint-disable-next-line no-new-func
new Function(code)()

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL ${name}\n       ${String(error && error.message ? error.message : error)}\n`)
  }
}

process.stdout.write('dsh-user-markdown — renderer tests\n')

test('bundle 通过 __ModuleLoader__.load 注册，且 id 与包名一致', () => {
  assert.ok(registration, '未调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-user-markdown')
  assert.equal(typeof registration.factory, 'function')
})

const mod = registration.factory(() => {
  throw new Error('本插件不请求任何外部模块')
})

test('factory 返回 cordis 客户端插件形态', () => {
  assert.equal(mod.name, 'dsh-user-markdown')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.__test.renderMarkdown, 'function')
})

const { renderMarkdown, renderInline, escapeHtml, safeUrl } = mod.__test

test('HTML 转义覆盖五个危险字符', () => {
  assert.equal(escapeHtml('<a href="x" & \'y\'>'), '&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;')
})

test('协议白名单：javascript:/data: 降级为 #', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '#')
  assert.equal(safeUrl('data:text/html,x'), '#')
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeUrl('/local/path'), '/local/path')
})

test('标题渲染', () => {
  assert.equal(renderMarkdown('# 一级'), '<h1>一级</h1>')
  assert.equal(renderMarkdown('### 三级 ###'), '<h3>三级</h3>')
  assert.equal(renderMarkdown('###### 六级'), '<h6>六级</h6>')
  assert.equal(renderMarkdown('# 无空格不是标题'), '<h1>无空格不是标题</h1>')
})

test('强调 / 删除线', () => {
  assert.equal(renderInline('**粗**'), '<strong>粗</strong>')
  assert.equal(renderInline('*斜*'), '<em>斜</em>')
  assert.equal(renderInline('***粗斜***'), '<strong><em>粗斜</em></strong>')
  assert.equal(renderInline('~~删~~'), '<del>删</del>')
  assert.equal(renderInline('a_b_c'), 'a_b_c', '词内下划线不应触发斜体')
})

test('行内代码保持原样且自身被转义', () => {
  assert.equal(renderInline('`AAA`'), '<code>AAA</code>')
  assert.equal(renderInline('`<b>x</b>`'), '<code>&lt;b&gt;x&lt;/b&gt;</code>')
})

test('围栏代码块保留缩进与换行，并记录语言', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n  indented\n```')
  assert.equal(html, '<pre data-lang="js"><code>const a = 1;\n  indented</code></pre>')
})

test('围栏代码块内的 Markdown 不被解析', () => {
  const html = renderMarkdown('```\n# not a heading\n**not bold**\n```')
  assert.ok(html.includes('# not a heading'), html)
  assert.ok(html.includes('**not bold**'), html)
  assert.ok(!html.includes('<h1>'), html)
})

test('XSS：标签与事件属性一律转义', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>')
  assert.ok(!html.includes('<img src=x'), html)
  assert.ok(html.includes('&lt;img'), html)
})

test('链接：正常链接可点，危险协议被拦截', () => {
  assert.equal(
    renderInline('[官网](https://example.com)'),
    '<a href="https://example.com" target="_blank" rel="noreferrer noopener">官网</a>'
  )
  const evil = renderInline('[点我](javascript:alert(1))')
  assert.ok(evil.includes('href="#"'), evil)
  assert.ok(!evil.includes('javascript:alert'), evil)
})

test('裸链接自动成链', () => {
  assert.equal(
    renderInline('见 https://example.com/x?a=1 结束'),
    '见 <a href="https://example.com/x?a=1" target="_blank" rel="noreferrer noopener">https://example.com/x?a=1</a> 结束'
  )
})

test('无序 / 有序列表', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
})

test('引用块', () => {
  assert.equal(renderMarkdown('> 引用'), '<blockquote><p>引用</p></blockquote>')
  assert.equal(renderMarkdown('> 第一行\n> 第二行'), '<blockquote><p>第一行<br>第二行</p></blockquote>')
})

test('表格', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.equal(
    html,
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  )
})

test('分隔线', () => {
  assert.equal(renderMarkdown('---'), '<hr>')
  assert.equal(renderMarkdown('***'), '<hr>')
})

test('段落保留换行（聊天场景按硬换行处理）', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行<br>第二行</p>')
})

test('空行切分为独立段落', () => {
  assert.equal(renderMarkdown('第一段\n\n第二段'), '<p>第一段</p><p>第二段</p>')
})

test('换行语义与浏览器 pre-wrap 对齐：孤立 CR 不换行（回归 #1）', () => {
  // 浏览器实测：'\n' 与 '\r\n' 换行；孤立 '\r' 被忽略（渲染宽度等于直接删除）
  assert.equal(renderMarkdown('A\rB'), '<p>AB</p>')
  assert.equal(renderMarkdown('A\r\nB'), '<p>A<br>B</p>')
  assert.equal(renderMarkdown('A\nB'), '<p>A<br>B</p>')
})

test('含孤立 CR 的真实会话文本仍能正确渲染行内代码（回归 #1）', () => {
  const stored = '我发给你一段文本 \r`AAA\r`\r\n这段文本采用了markdown格式的标记，对吗？'
  assert.equal(
    renderMarkdown(stored),
    '<p>我发给你一段文本 <code>AAA</code><br>这段文本采用了markdown格式的标记，对吗？</p>'
  )
})

test('多行混合文档（回归样例）', () => {
  const html = renderMarkdown([
    '## 标题',
    '',
    '正文 **加粗** 与 `code`，还有 [链接](https://example.com)。',
    '',
    '- 一',
    '- 二',
    '',
    '```python',
    'print("hi")',
    '```'
  ].join('\n'))
  assert.ok(html.indexOf('<h2>标题</h2>') === 0, html)
  assert.ok(html.includes('<strong>加粗</strong>'), html)
  assert.ok(html.includes('<code>code</code>'), html)
  assert.ok(html.includes('<ul><li>一</li><li>二</li></ul>'), html)
  assert.ok(html.includes('<pre data-lang="python"><code>print(&quot;hi&quot;)</code></pre>'), html)
})

test('纯函数：同一输入两次渲染结果一致（幂等）', () => {
  const source = '# t\n\n- a\n- b\n\n`x`'
  assert.equal(renderMarkdown(source), renderMarkdown(source))
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
