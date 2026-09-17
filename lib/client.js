/**
 * dsh-user-markdown — browser half（自包含客户端 bundle）。
 *
 * 目标：让「用户自己发出的消息」在 DSH Web GUI 中也按 Markdown 渲染。
 *
 * 设计取舍（兼容性优先）
 * ----------------------
 * DSH 的用户气泡由 `conversation.chat.node` 这个 keyed slot 的 `user` / `steering`
 * 渲染器产出，而该 slot 是 **替换语义**：任何注册了同一个 key 的插件（例如
 * dsh-easyrewrite 的 UserBubbleView）都会把原生渲染器整体顶掉。如果本插件也去
 * 抢注这个 slot，就会和 easyrewrite / rewind 之类的插件互相覆盖。
 *
 * 因此这里改走 **DOM 增强层**：只观察聊天流里已经渲染出来的用户消息容器
 * （`data-chat-flow-kind="user"` / `steering` / 乐观回显），把其中的纯文本内容替换为
 * 渲染后的 Markdown DOM。谁来渲染气泡都无所谓——原生、easyrewrite 替换版、
 * 未来任何插件版，只要文本落进 DOM，本插件都能生效。
 *
 * 安全要点
 * --------
 * 1. 只处理「除文本节点外没有其它元素子节点」的容器：含引用 chip / 附件块 /
 *    编辑框的气泡一律跳过，绝不打断别人写进去的结构。
 * 2. 只处理 `white-space: pre-wrap|pre-line|break-spaces` 的元素：这是「纯文本
 *    消息体」的判据，时间戳、按钮、操作区因此天然被排除。
 * 3. 编辑态（textarea / input / contenteditable）整条跳过。
 * 4. 渲染前一律 HTML 转义，链接走协议白名单，杜绝把用户输入当 HTML 执行。
 * 5. 只清空文本节点的 nodeValue、只追加自己的 div——不删除、不包裹 React 拥有的
 *    节点，React 后续更新不会因此抛错；文本一变，MutationObserver 会重新渲染。
 */

window.__ModuleLoader__.load({
  id: 'dsh-user-markdown',
  factory: function (_require) {
    'use strict'

    /* ==================================================================
     * 0. 常量
     * ================================================================== */

    /** localStorage 开关键：置为 '0' 即临时停用（无需改配置）。 */
    var STORAGE_ENABLED = 'dsh-user-markdown:enabled'
    /** 我们插入的渲染体标记（同时作为「已渲染」判据）。 */
    var BODY_ATTR = 'data-dsh-user-md-body'
    /** 记录该容器本轮渲染所用的 Markdown 源文本。 */
    var SRC_ATTR = 'data-dsh-user-md-src'
    var STYLE_ID = 'dsh-user-markdown/style'

    /**
     * 用户消息容器选择器。
     * - `data-chat-flow-kind=user|steering`：持久化的用户消息 / 插话消息（ChatView flowItem）
     * - `data-submission-echo` / `data-pending-steering`：本地乐观回显 / 待定插话气泡
     * 这些属性由 ui-chat 与第三方气泡实现共同写入，因此对「原生渲染器」和
     * 「替换了 conversation.chat.node 的插件」都成立。
     */
    var HOST_SELECTOR = [
      '[data-chat-flow-kind="user"]',
      '[data-chat-flow-kind="steering"]',
      '[data-submission-echo]',
      '[data-pending-steering]'
    ].join(',')

    /** 行内代码占位符（私有使用区字符，正常文本几乎不可能出现）。 */
    var PH_OPEN = '\uE000'
    var PH_CLOSE = '\uE001'

    /* ==================================================================
     * 1. Markdown → HTML（自包含，零依赖）
     * ================================================================== */

    /**
     * HTML 转义（文本与属性通用）。
     * @param {unknown} value - 任意值。
     * @returns {string} 转义后的字符串。
     */
    function escapeHtml(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /** 链接协议白名单：相对路径、锚点、http(s)、mailto、tel。 */
    var SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|\/|\.{1,2}\/|#)/i

    /**
     * 归一化一个链接目标；不在白名单内的协议一律降级为 '#'。
     * @param {string} raw - Markdown 中写下的原始目标（已 HTML 转义）。
     * @returns {string} 可安全放进 href/src 的字符串。
     */
    function safeUrl(raw) {
      var url = String(raw || '').trim()
      if (url === '') return '#'
      if (SAFE_URL.test(url)) return url
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(url)) return 'mailto:' + url
      return '#'
    }

    /**
     * 渲染一行（或一段）内的行内语法：行内代码、图片、链接、裸链接、粗体、斜体、删除线。
     * @param {string} text - 未转义的原始文本。
     * @returns {string} HTML 片段（除本函数自己生成的标签外全部已转义）。
     */
    function renderInline(text) {
      var codes = []
      var source = String(text === null || text === undefined ? '' : text)

      // 1) 先摘出行内代码，避免其内容被后续规则改写
      source = source.replace(/(`+)([\s\S]*?)\1/g, function (_match, _ticks, body) {
        codes.push(String(body).replace(/^[ \t]+|[ \t]+$/g, ''))
        return PH_OPEN + (codes.length - 1) + PH_CLOSE
      })

      var html = escapeHtml(source)

      // 2) 图片（丢弃无法安全解析的目标，避免渲染空 img）
      html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (match, alt, url) {
        var safe = safeUrl(url)
        if (safe === '#') return match
        return '<img src="' + safe + '" alt="' + alt + '" loading="lazy">'
      })

      // 3) 链接
      html = html.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_match, label, url) {
        return '<a href="' + safeUrl(url) + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
      })

      // 4) 裸链接（避免吞掉已生成的 href 属性：只匹配前面是行首/空白/括号的位置）
      html = html.replace(/(^|[\s(（>])(https?:\/\/[^\s<>"')\u3002]+)/g, function (_match, lead, url) {
        return lead + '<a href="' + safeUrl(url) + '" target="_blank" rel="noreferrer noopener">' + url + '</a>'
      })

      // 5) 强调
      html = html.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      html = html.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')

      // 6) 还原行内代码
      html = html.replace(/\uE000(\d+)\uE001/g, function (_match, index) {
        return '<code>' + escapeHtml(codes[Number(index)] || '') + '</code>'
      })

      return html
    }

    /**
     * 判断某一行是否会开启一个新的块级结构（供段落收集时判断边界）。
     * @param {string} line - 单行文本。
     * @returns {boolean} 是否为块级起始行。
     */
    function isBlockStart(line) {
      if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true
      if (/^ {0,3}#{1,6}[ \t]/.test(line)) return true
      if (/^ {0,3}(?:#{1,6})[ \t]*$/.test(line)) return true
      if (/^ {0,3}>/.test(line)) return true
      if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line)) return true
      if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) return true
      return false
    }

    /** 表格分隔行：至少一个 `-`，其余是 `|`、`:`、`-`、空白。 */
    function isTableDivider(line) {
      var trimmed = String(line).trim()
      if (trimmed.indexOf('-') === -1) return false
      return /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(trimmed)
    }

    /** 拆分一行表格为单元格数组。 */
    function splitTableRow(line) {
      var trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
      return trimmed.split('|').map(function (cell) { return cell.trim() })
    }

    /**
     * 把 Markdown 源文本渲染为 HTML 字符串。
     *
     * 支持：围栏代码块、标题、分隔线、引用、有序/无序列表、表格、段落；
     * 段落内的单个换行按硬换行（`<br>`）处理——聊天场景下这最符合书写直觉。
     *
     * **换行语义必须与浏览器渲染 `white-space: pre-wrap` 时逐字符一致**，
     * 否则「渲染」本身就会改变原文的视觉结构。实测（Chromium）：
     *
     * | 源文本 | pre-wrap 下的表现 |
     * | --- | --- |
     * | `\n` | 换行 |
     * | `\r\n` | 换行（一个） |
     * | 孤立 `\r` | **不换行，直接被忽略**（`'A\rB'` 的渲染宽度 === `'AB'`） |
     *
     * DSH 的用户消息里确实会出现孤立 `\r`（粘贴、输入法等来源），所以这里
     * 只把 CRLF 归一成 LF，孤立 CR 直接丢弃。早期版本写成 `.replace(/\r\n?/g, '\n')`，
     * 把孤立 CR 也当成了换行，于是含 CR 的历史消息被额外拆行、行内代码的反引号
     * 被拆散——那是一次实打实的回归，不要改回去。
     *
     * @param {string} source - Markdown 源文本。
     * @returns {string} HTML 字符串。
     */
    function renderMarkdown(source) {
      var text = String(source === null || source === undefined ? '' : source)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '')
      var lines = text.split('\n')
      var out = []
      var i = 0

      function isBlank(line) { return /^[ \t]*$/.test(line) }

      while (i < lines.length) {
        var line = lines[i]

        // --- 围栏代码块 ---
        var fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/.exec(line)
        if (fence) {
          var marker = fence[1].charAt(0)
          var fenceLen = fence[1].length
          var lang = fence[2] || ''
          var body = []
          i += 1
          var closeRe = new RegExp('^ {0,3}' + (marker === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$')
          while (i < lines.length) {
            if (closeRe.test(lines[i])) { i += 1; break }
            body.push(lines[i])
            i += 1
          }
          out.push(
            '<pre' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '><code>' +
            escapeHtml(body.join('\n')) + '</code></pre>'
          )
          continue
        }

        // --- 空行 ---
        if (isBlank(line)) { i += 1; continue }

        // --- 标题 ---
        var heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line)
        if (!heading) heading = /^ {0,3}(#{1,6})[ \t]*$/.exec(line)
        if (heading) {
          var level = heading[1].length
          out.push('<h' + level + '>' + renderInline(heading[2] || '') + '</h' + level + '>')
          i += 1
          continue
        }

        // --- 分隔线 ---
        if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
          out.push('<hr>')
          i += 1
          continue
        }

        // --- 引用（连续 `>` 行合并，支持嵌套） ---
        if (/^ {0,3}>/.test(line)) {
          var quoted = []
          while (i < lines.length && !isBlank(lines[i]) && /^ {0,3}>/.test(lines[i])) {
            quoted.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''))
            i += 1
          }
          out.push('<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>')
          continue
        }

        // --- 列表（同一层级、同一类型连续成表） ---
        var listItem = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line)
        if (listItem) {
          var ordered = /\d/.test(listItem[1])
          var items = []
          while (i < lines.length) {
            var next = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(lines[i])
            if (!next) break
            if (/\d/.test(next[1]) !== ordered) break
            items.push(next[2])
            i += 1
          }
          var tag = ordered ? 'ol' : 'ul'
          out.push('<' + tag + '>' + items.map(function (item) {
            return '<li>' + renderInline(item) + '</li>'
          }).join('') + '</' + tag + '>')
          continue
        }

        // --- 表格 ---
        if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
          var header = splitTableRow(line)
          i += 2
          var rows = []
          while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1 && !isTableDivider(lines[i])) {
            rows.push(splitTableRow(lines[i]))
            i += 1
          }
          var table = '<table><thead><tr>' + header.map(function (cell) {
            return '<th>' + renderInline(cell) + '</th>'
          }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
            return '<tr>' + row.map(function (cell) {
              return '<td>' + renderInline(cell) + '</td>'
            }).join('') + '</tr>'
          }).join('') + '</tbody></table>'
          out.push(table)
          continue
        }

        // --- 段落（段内换行 = 硬换行） ---
        var paragraph = [line]
        i += 1
        while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
          // 段落中断出表格时也要停下来
          if (lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableDivider(lines[i + 1])) break
          paragraph.push(lines[i])
          i += 1
        }
        out.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>')
      }

      return out.join('')
    }

    /* ==================================================================
     * 2. 样式
     * ================================================================== */

    /**
     * 气泡内 Markdown 的样式。使用中性半透明色，自动适配深浅色主题；
     * 关键一条是 `white-space: normal`：气泡本身是 pre-wrap（为保留纯文本换行），
     * 渲染后的块级结构必须切回 normal，否则每个标签换行都会多出一行空白。
     */
    var CSS = [
      '[', BODY_ATTR, ']{white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-align:start}',
      '[', BODY_ATTR, ']>:first-child{margin-top:0}',
      '[', BODY_ATTR, ']>:last-child{margin-bottom:0}',
      '[', BODY_ATTR, '] p{margin:0 0 .55em}',
      '[', BODY_ATTR, '] h1,[', BODY_ATTR, '] h2,[', BODY_ATTR, '] h3,[', BODY_ATTR, '] h4,[', BODY_ATTR, '] h5,[', BODY_ATTR, '] h6{margin:.6em 0 .35em;font-weight:600;line-height:1.35}',
      '[', BODY_ATTR, '] h1{font-size:1.32em}',
      '[', BODY_ATTR, '] h2{font-size:1.2em}',
      '[', BODY_ATTR, '] h3{font-size:1.1em}',
      '[', BODY_ATTR, '] h4,[', BODY_ATTR, '] h5,[', BODY_ATTR, '] h6{font-size:1em}',
      '[', BODY_ATTR, '] ul,[', BODY_ATTR, '] ol{margin:.25em 0 .55em;padding-left:1.4em}',
      '[', BODY_ATTR, '] li{margin:.14em 0}',
      '[', BODY_ATTR, '] li>ul,[', BODY_ATTR, '] li>ol{margin:.14em 0}',
      '[', BODY_ATTR, '] code{font-family:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace);font-size:.92em;background:rgba(127,127,127,.20);border-radius:4px;padding:1px 5px}',
      '[', BODY_ATTR, '] pre{background:rgba(127,127,127,.16);border-radius:10px;padding:9px 11px;margin:.45em 0;overflow:auto;max-height:420px}',
      '[', BODY_ATTR, '] pre code{background:none;padding:0;font-size:.9em;white-space:pre}',
      '[', BODY_ATTR, '] blockquote{margin:.4em 0;padding:0 0 0 10px;border-left:3px solid rgba(127,127,127,.45);opacity:.94}',
      '[', BODY_ATTR, '] a{color:inherit;text-decoration:underline;text-underline-offset:2px}',
      '[', BODY_ATTR, '] hr{border:0;border-top:1px solid rgba(127,127,127,.38);margin:.6em 0}',
      '[', BODY_ATTR, '] table{border-collapse:collapse;margin:.4em 0;font-size:.95em}',
      '[', BODY_ATTR, '] th,[', BODY_ATTR, '] td{border:1px solid rgba(127,127,127,.38);padding:3px 8px}',
      '[', BODY_ATTR, '] img{max-width:100%;border-radius:8px}',
      '[', BODY_ATTR, '] del{opacity:.75}'
    ].join('')

    /**
     * 注入（或复用）样式标签。使用 `data-plugin` / `data-plugin-css` 属性，
     * 这是 DSH 客户端模块系统的约定，插件卸载时由 HMR 驱动器负责回收。
     * @returns {HTMLStyleElement|undefined} 样式元素。
     */
    function injectStyle() {
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return existing
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-user-markdown'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    /* ==================================================================
     * 3. DOM 增强
     * ================================================================== */

    /** 读取开关（localStorage；异常时按启用处理）。 */
    function isEnabled() {
      try { return window.localStorage.getItem(STORAGE_ENABLED) !== '0' } catch (_error) { return true }
    }

    /** 拼接元素「直接子文本节点」的内容（不含后代元素的文本）。 */
    function directTextOf(el) {
      var out = ''
      var kids = el.childNodes
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) out += kids[i].nodeValue || ''
      }
      return out
    }

    /**
     * 容器是否「只由文本（+ 我们自己的渲染体 + 注释）构成」。
     * 含引用 chip、附件块、按钮等元素子节点时返回 false —— 这类气泡整条跳过，
     * 以免打断别的插件（或原生渲染器）写进去的结构。
     */
    function hasOnlyTextChildren(el) {
      var kids = el.childNodes
      for (var i = 0; i < kids.length; i++) {
        var node = kids[i]
        if (node.nodeType === 1) {
          if (node.hasAttribute && node.hasAttribute(BODY_ATTR)) continue
          return false
        }
        if (node.nodeType !== 3 && node.nodeType !== 8) return false
      }
      return true
    }

    /** 是否为「保留空白」的文本容器（纯文本消息体的判据）。 */
    function isPreWrap(el) {
      try {
        var ws = window.getComputedStyle(el).whiteSpace
        return ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces'
      } catch (_error) {
        return false
      }
    }

    /** 查找本插件此前插入的渲染体（直接子元素）。 */
    function findBody(el) {
      var kids = el.children
      if (!kids) return null
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].hasAttribute(BODY_ATTR)) return kids[i]
      }
      return null
    }

    /** 清空容器的直接文本节点（保留节点对象本身，React 的引用不会失效）。 */
    function clearDirectText(el) {
      var kids = el.childNodes
      for (var i = kids.length - 1; i >= 0; i--) {
        var node = kids[i]
        if (node.nodeType === 3 && node.nodeValue !== '') node.nodeValue = ''
      }
    }

    /**
     * 处理一个候选文本容器。
     * @param {Element} el - 候选元素。
     */
    function renderOne(el) {
      if (el.isContentEditable) return
      if (!isPreWrap(el)) return
      if (!hasOnlyTextChildren(el)) return
      if (el.childNodes.length === 0) return

      var raw = directTextOf(el)
      var body = findBody(el)
      var previous = el.getAttribute(SRC_ATTR) || ''

      // 文本节点已被本插件清空且没有新的文本写入 → 维持现状（避免自激循环）
      if (raw.replace(/\s+/g, '') === '' && body !== null) return
      if (raw.trim() === '') return

      var source = raw
      if (body !== null && source === previous) return

      var html = renderMarkdown(source)
      if (body === null) {
        body = document.createElement('div')
        body.setAttribute(BODY_ATTR, '1')
        el.appendChild(body)
      }
      if (body.__dshUserMdHtml !== html) {
        body.innerHTML = html
        body.__dshUserMdHtml = html
      }
      el.setAttribute(SRC_ATTR, source)
      clearDirectText(el)
    }

    /**
     * 处理一条用户消息容器内的所有候选文本元素。
     * @param {Element} host - 用户消息容器。
     */
    function processHost(host) {
      // 编辑态（dsh-easyrewrite 的 textarea / 原生编辑器）不下手
      if (host.querySelector('textarea, input, [contenteditable="true"]')) return
      var all = host.querySelectorAll('*')
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        if (el.hasAttribute(BODY_ATTR)) continue
        if (el.isContentEditable) continue
        if (el.childNodes.length === 0) continue
        // 跳过我们渲染体内部的元素
        if (el.closest && el.closest('[' + BODY_ATTR + ']')) continue
        renderOne(el)
      }
    }

    /**
     * 撤销单个容器的渲染，尽力把原文写回。
     * @param {Element} el - 被本插件处理过的容器。
     */
    function restoreOne(el) {
      var source = el.getAttribute(SRC_ATTR) || ''
      var body = findBody(el)
      if (body && body.parentNode === el) el.removeChild(body)
      el.removeAttribute(SRC_ATTR)
      if (!source) return
      var kids = el.childNodes
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) { kids[i].nodeValue = source; return }
      }
      el.insertBefore(document.createTextNode(source), el.firstChild)
    }

    /** 撤销全部渲染。 */
    function restoreAll() {
      var bodies = document.querySelectorAll('[' + BODY_ATTR + ']')
      for (var i = 0; i < bodies.length; i++) {
        var parent = bodies[i].parentNode
        if (parent && parent.removeChild) parent.removeChild(bodies[i])
      }
      var hosts = document.querySelectorAll('[' + SRC_ATTR + ']')
      for (var j = 0; j < hosts.length; j++) {
        var el = hosts[j]
        var source = el.getAttribute(SRC_ATTR) || ''
        el.removeAttribute(SRC_ATTR)
        if (!source) continue
        var kids = el.childNodes
        var written = false
        for (var k = 0; k < kids.length; k++) {
          if (kids[k].nodeType === 3) { kids[k].nodeValue = source; written = true; break }
        }
        if (!written) el.insertBefore(document.createTextNode(source), el.firstChild)
      }
    }

    /* ==================================================================
     * 4. 插件入口
     * ================================================================== */

    /** 扫描节流窗口（毫秒）：把一轮 mutation 风暴合并成一次扫描。 */
    var SCAN_DELAY = 60

    /**
     * cordis 客户端插件入口。
     * @param {import('@deepseek-ai/cordis').Context} _ctx - 客户端上下文（本插件不消费服务）。
     * @returns {() => void} 卸载回调。
     */
    function apply(_ctx) {
      var style = injectStyle()
      var observer = null
      var timer = 0
      var disposed = false

      function scan() {
        if (disposed || !isEnabled()) return
        if (observer) observer.disconnect()
        try {
          var hosts = document.querySelectorAll(HOST_SELECTOR)
          for (var i = 0; i < hosts.length; i++) processHost(hosts[i])
        } catch (_error) {
          // 单次扫描失败不该影响后续调度
        } finally {
          if (observer && !disposed) {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          }
        }
      }

      function schedule() {
        if (disposed || timer) return
        timer = window.setTimeout(function () {
          timer = 0
          scan()
        }, SCAN_DELAY)
      }

      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      scan()

      // 调试/逃生舱：可在控制台直接切换、重扫或调用渲染器
      try {
        window.__dshUserMarkdown = {
          enabled: isEnabled,
          enable: function () { try { window.localStorage.setItem(STORAGE_ENABLED, '1') } catch (_e) {} scan(); return true },
          disable: function () { try { window.localStorage.setItem(STORAGE_ENABLED, '0') } catch (_e) {} restoreAll(); return false },
          toggle: function () { return isEnabled() ? window.__dshUserMarkdown.disable() : window.__dshUserMarkdown.enable() },
          refresh: function () { restoreAll(); scan() },
          render: renderMarkdown
        }
      } catch (_error) { /* 只读环境忽略 */ }

      return function dispose() {
        disposed = true
        if (timer) window.clearTimeout(timer)
        if (observer) observer.disconnect()
        restoreAll()
        if (style && style.parentNode) style.parentNode.removeChild(style)
        try { delete window.__dshUserMarkdown } catch (_error) { /* ignore */ }
      }
    }

    return {
      name: 'dsh-user-markdown',
      apply: apply,
      __test: {
        escapeHtml: escapeHtml,
        safeUrl: safeUrl,
        renderInline: renderInline,
        renderMarkdown: renderMarkdown
      }
    }
  }
})
