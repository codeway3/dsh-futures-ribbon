// 冒烟测试：在 Node 里用真 React 渲染行情带客户端组件，提前发现前端错误。
// 用法：
//   node scripts/render-smoke.cjs [react 模块目录]
//   FR_MODE=landing node scripts/render-smoke.cjs   # 模拟新会话落地页（行情带应产出 0 字符）
// react 模块目录默认取环境变量 FR_REACT_DIR，否则取本项目的 node_modules。
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = process.argv[2] || process.env.FR_REACT_DIR || path.join(__dirname, '..', 'node_modules')
const React = require(path.join(ROOT, 'react'))
const ReactDOMServer = require(path.join(ROOT, 'react-dom/server'))

const code = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

const store = {}
let captured = null

// 模拟"新会话落地页"：输入框 placeholder 是落地页文案
const LANDING = process.env.FR_MODE === 'landing'
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(mod) {
        captured = mod
      },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ borderTopLeftRadius: '12px' }),
    location: { href: 'http://127.0.0.1/' },
  },
  document: {
    hidden: false,
    body: {
      innerText: LANDING ? '探索未至之境 预览版' : '对话内容',
    },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ getContext: () => ({ font: '', measureText: (t) => ({ width: String(t).length * 8 }) }) }),
    querySelector(sel) {
      if (sel.indexOf('textarea') < 0) return null
      return {
        getAttribute: (n) => (n === 'placeholder' ? (LANDING ? '描述你想要构建的内容，/ 调用指令，@ 文件或对话' : '给 DeepSeek Harness 发送消息…') : null),
        parentElement: null,
        getBoundingClientRect: () => ({ width: 720 }),
      }
    },
    querySelectorAll() {
      return []
    },
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
  },
  fetch: async () => ({ json: async () => ({ ok: true, catalog: [], rows: [] }) }),
  setTimeout,
  clearTimeout,
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

console.log('  1) 捕获到模块: ' + (captured ? captured.id : '否'))
if (!captured) process.exit(1)
const pkgName = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).name
console.log('  2) id 与包名一致: ' + (captured.id === pkgName))

const fakeRequire = (id) => {
  if (id === 'react') return React
  throw new Error('未预期的依赖: ' + id)
}
const plugin = captured.factory(fakeRequire)
console.log('  3) 插件对象 inject: ' + JSON.stringify(plugin.inject) + ' | apply: ' + typeof plugin.apply)

const registered = []
const disposed = []
const fakeCtx = {
  slots: {
    inject(name, cb) {
      const d = cb()
      disposed.push(typeof d)
      return d
    },
    register(options, Component) {
      registered.push({ slot: options.name, id: options.id, order: options.order, component: Component })
      return () => {}
    },
  },
  effect(fn) {
    const d = fn()
    disposed.push(typeof d)
    return d
  },
}
plugin.apply(fakeCtx)
console.log('  4) 注册的插槽: ' + registered.map((r) => r.slot + '#' + r.id + '@' + r.order).join(' | '))

const warnings = []
const origErr = console.error
console.error = (...a) => {
  warnings.push(a.join(' ').slice(0, 200))
}
let ok = 0
for (const r of registered) {
  try {
    const html = ReactDOMServer.renderToString(React.createElement(r.component, {}))
    ok++
    console.log('  5) 渲染 ' + r.id + ' ✓ 产出 ' + html.length + ' 字符: ' + html.slice(0, 100).replace(/\n/g, ' '))
  } catch (e) {
    console.log('  5) 渲染 ' + r.id + ' ✗ ' + e.message)
  }
}
console.error = origErr
if (warnings.length) console.log('  6) 渲染警告 ' + warnings.length + ' 条: ' + warnings.slice(0, 3).join(' // '))
console.log('  结果: 渲染 ' + ok + '/' + registered.length + ' 个组件通过')
