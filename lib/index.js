/**
 * dsh-user-markdown — node half（宿主半侧）。
 *
 * 本插件的主体是浏览器半侧（`lib/client.js`）。宿主半侧唯一的作用是：
 * 让本包成为 cordis 装配树中的一个「已启用 Loader 条目」——`@deepseek-ai/dsh-client-modules`
 * 的宿主半侧会扫描已启用条目并据此把 `lib/client.js` 组合进 Web 启动图。
 *
 * 因此这里刻意不 inject 任何宿主服务、不注册任何能力：插件不触碰模型上下文、
 * 不写会话、不改配置，卸载与加载都只影响浏览器端的展示层。
 *
 * @module dsh-user-markdown
 */

/** 插件名（== 包名，也是客户端 bundle 的模块 id）。 */
export const name = 'dsh-user-markdown'

/**
 * 不依赖任何宿主服务。留空数组而不是省略，是为了显式表达「无服务依赖」，
 * 避免宿主在服务未就绪时延迟激活本条目（条目激活得越早，客户端 sidecar 越早进入启动图）。
 */
export const inject = []

/**
 * 宿主侧入口：什么都不做，仅登记一条调试日志并返回 disposer。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 * @returns {() => void} 卸载回调。
 */
export function apply(ctx) {
  try {
    ctx?.logger?.debug?.('[dsh-user-markdown] host half active（仅用于让 client bundle 进入启动图）')
  } catch {
    // logger 形态随版本变化：日志失败不影响插件
  }
  return () => {}
}
