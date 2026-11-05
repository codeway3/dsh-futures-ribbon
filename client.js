/**
 * 行情带 —— 客户端半（v0.3.0）。
 *
 * 交互与视觉要点：
 *  - 默认注入 conversation.composer.dock（输入框内部 → 与对话框同宽对齐），
 *    若宿主无此槽则回退 conversation.input.dock
 *  - 纯单色，方向用 ↑ ↓；数字变化做交易所翻牌（逐字符 rotateX）
 *  - 内容溢出时缓慢滚动一遍（出去→停→回来），两侧渐隐，悬停暂停
 *  - 点击（不 hover）打开：点哪个合约就以哪个合约展开详情
 *  - 设置放在 DSH 设置菜单（settings.section），浮层里不再有设置
 */
window.__ModuleLoader__.load({
  id: 'dsh-futures-ribbon',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement

    const API = '/futures-ribbon/api'
    const CFG_KEY = 'dsh-futures-ribbon.config.v1'
    const DEFAULT_CODES = ['RU0', 'CF0', 'SR0', 'M0', 'P0', 'I0', 'JD0', 'CU0', 'AU0', 'LH0']
    const DEFAULT_CFG = {
      codes: DEFAULT_CODES.slice(),
      interval: 5,
      location: 'dock',
      rotateSec: 4,
      hidden: false,
      anim: 'fade',
    }

    /* ───────────── 配置（实时读 localStorage，多窗口同步） ───────────── */

    const cfgSubs = new Set()

    function readCfg() {
      let out = Object.assign({}, DEFAULT_CFG, { codes: DEFAULT_CODES.slice() })
      try {
        const raw = localStorage.getItem(CFG_KEY)
        if (raw) out = Object.assign(out, JSON.parse(raw))
      } catch (e) {
        /* 存储不可用 */
      }
      if (!Array.isArray(out.codes) || out.codes.length === 0) out.codes = DEFAULT_CODES.slice()
      return out
    }

    function notifyCfg() {
      const next = readCfg()
      cfgSubs.forEach((f) => f(next))
    }

    function writeCfg(patch) {
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign({}, readCfg(), patch)))
      } catch (e) {
        /* 忽略不可写存储 */
      }
      notifyCfg()
    }

    function useCfg() {
      const [cfg, setCfg] = useState(readCfg)
      useEffect(() => {
        const f = (n) => setCfg(Object.assign({}, n))
        cfgSubs.add(f)
        setCfg(Object.assign({}, readCfg()))
        return () => cfgSubs.delete(f)
      }, [])
      return cfg
    }

    /* ───────────── 浮层状态（含"点开时选中哪个合约"） ───────────── */

    let popState = { open: false, selected: null }
    const popSubs = new Set()
    let closeTimer = null

    function setPop(patch) {
      popState = Object.assign({}, popState, patch)
      const next = popState
      popSubs.forEach((f) => f(next))
    }

    function openWith(code) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      setPop({ open: true, selected: code || popState.selected || null })
    }

    function cancelClose() {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
    }

    function usePop() {
      const [s, setS] = useState(popState)
      useEffect(() => {
        const f = (n) => setS(Object.assign({}, n))
        popSubs.add(f)
        return () => popSubs.delete(f)
      }, [])
      return s
    }

    /* ───────────── 插槽模式（composer 优先，input 兜底） ───────────── */

    let slotMode = { composer: false }
    const slotSubs = new Set()

    function setSlotMode(patch) {
      slotMode = Object.assign({}, slotMode, patch)
      const next = slotMode
      slotSubs.forEach((f) => f(next))
    }

    function useSlotMode() {
      const [s, setS] = useState(slotMode)
      useEffect(() => {
        const f = (n) => setS(Object.assign({}, n))
        slotSubs.add(f)
        return () => slotSubs.delete(f)
      }, [])
      return s
    }

    /* ───────────── 数据 ───────────── */

    let catalogCache = null
    function useCatalog() {
      const [list, setList] = useState(catalogCache)
      useEffect(() => {
        if (catalogCache) {
          setList(catalogCache)
          return undefined
        }
        let alive = true
        fetch(API + '?op=catalog', { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => {
            if (!alive || !j || !j.ok || !Array.isArray(j.catalog)) return
            catalogCache = j.catalog
            setList(j.catalog)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return Array.isArray(list) ? list : []
    }

    /* ───────────── 交易时段（客户端副本） ─────────────
     * 宿主也有一份同样的表（index.js），那份用于"要不要去新浪拉行情"。
     * 这里这份只用于**显示**：不在交易时段就把箭头留空。
     * 之所以不依赖宿主返回值，是因为老版本宿主不返回 session 字段，
     * 而"收盘后不显示箭头"必须是纯前端就能生效的行为。
     */
    const MINS = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number)
      return h * 60 + m
    }
    const DAY_COMMODITY = [
      [MINS('09:00'), MINS('10:15')],
      [MINS('10:30'), MINS('11:30')],
      [MINS('13:30'), MINS('15:00')],
    ]
    const DAY_CFFEX_INDEX = [
      [MINS('09:30'), MINS('11:30')],
      [MINS('13:00'), MINS('15:00')],
    ]
    const DAY_CFFEX_BOND = [
      [MINS('09:30'), MINS('11:30')],
      [MINS('13:00'), MINS('15:15')],
    ]
    const CFFEX_SET = new Set(['IF', 'IH', 'IC', 'IM', 'TF', 'TS', 'T', 'TL'])
    const BOND_SET = new Set(['TF', 'TS', 'T', 'TL'])
    const NIGHT_0230_SET = new Set(['AU', 'AG', 'SC'])
    const NIGHT_0100_SET = new Set(['CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'SS', 'NR', 'RU', 'BU', 'FU', 'SP', 'LU', 'BC'])
    const NO_NIGHT_SET = new Set([
      'IF', 'IH', 'IC', 'IM', 'TF', 'TS', 'T', 'TL',
      'JD', 'LH', 'AP', 'CJ', 'PK', 'SF', 'SM', 'WH', 'PM', 'RI', 'LR', 'JR', 'BB', 'FB',
    ])

    const varietyOf = (code) => String(code || '').replace(/\d+$/, '').toUpperCase()

    /** 某合约此刻是否在交易：'open' | 'break' | 'closed'。 */
    const sessionStateOf = (code, now = new Date()) => {
      const mins = now.getHours() * 60 + now.getMinutes()
      const weekday = now.getDay() === 0 ? 7 : now.getDay()
      const isWeekend = weekday >= 6
      const v = varietyOf(code)
      const cffex = CFFEX_SET.has(v)
      const day = cffex ? (BOND_SET.has(v) ? DAY_CFFEX_BOND : DAY_CFFEX_INDEX) : DAY_COMMODITY
      const night = NO_NIGHT_SET.has(v) ? null : NIGHT_0230_SET.has(v) ? [MINS('21:00'), MINS('02:30')] : NIGHT_0100_SET.has(v) ? [MINS('21:00'), MINS('01:00')] : [MINS('21:00'), MINS('23:00')]

      if (!isWeekend && day.some(([a, b]) => mins >= a && mins < b)) return 'open'
      if (night) {
        const [start, end] = night
        if (end > start) {
          if (!isWeekend && mins >= start && mins < end) return 'open'
        } else {
          const prevDay = weekday === 1 ? 7 : weekday - 1
          if (mins < end && prevDay >= 1 && prevDay <= 5) return 'open'
          if (!isWeekend && mins >= start) return 'open'
        }
      }
      if (isWeekend) return 'closed'
      if (!cffex && mins >= MINS('10:15') && mins < MINS('10:30')) return 'break'
      if (mins >= MINS('11:30') && mins < MINS('13:30')) return 'break'
      return 'closed'
    }

    /** 汇总一组行的状态，用于拉取节流（只要有一个在交易就按正常频率拉）。 */
    const overallStateOf = (rows) => {
      const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.session && r.session.state)
      if (list.length === 0) return 'open'
      if (list.some((r) => r.session.state === 'open')) return 'open'
      if (list.some((r) => r.session.state === 'break')) return 'break'
      return 'closed'
    }

    function useQuotes(cfg, active) {
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const codesKey = cfg.codes.join(',')

      useEffect(() => {
        if (!active) return undefined
        let alive = true
        let timer = null
        let sessionState = 'open'
        let firstFetch = true

        const tick = async () => {
          if (typeof document !== 'undefined' && document.hidden && !firstFetch) {
            timer = setTimeout(tick, 15000)
            return
          }
          firstFetch = false
          try {
            const res = await fetch(API + '?op=quotes&codes=' + encodeURIComponent(codesKey), { cache: 'no-store' })
            const json = await res.json()
            if (!alive) return
            if (json && json.ok) {
              const rows = (Array.isArray(json.rows) ? json.rows : []).map((r) => {
                if (!r || r.stale || !Number.isFinite(r.last)) return r
                // 不在交易时段（休市/小休/周末）→ 箭头留空、不参与跳动统计。
                // 优先用宿主给的 session；老版本宿主没有该字段时，用本地时段表兜底。
                const state = (r.session && r.session.state) || sessionStateOf(r.code)
                const session = r.session || { state: state }
                if (state !== 'open') return Object.assign({}, r, { tick: null, session: session })
                const t = tickLevelFor(r.code, r.last)
                return Object.assign({}, r, {
                  tick: t.level > 0 ? { dir: t.dir, level: t.level } : null,
                  session: session,
                })
              })
              setData(Object.assign({}, json, { rows: rows }))
              setErr(null)
              // 全局节流也以本地时段表为准，避免依赖宿主版本
              sessionState = overallStateOf(rows)
            } else {
              setErr((json && json.error) || '行情获取失败')
            }
          } catch (e) {
            if (alive) setErr(String((e && e.message) || e))
          }
          if (!alive) return
          // 休市时拉取的收益很低：全局休市 5 分钟一次，小休/午休 2 分钟一次
          const base = Math.max(3, Number(cfg.interval) || 5)
          const seconds = sessionState === 'closed' ? 300 : sessionState === 'break' ? 120 : base
          timer = setTimeout(tick, seconds * 1000)
        }

        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [codesKey, cfg.interval, active])

      return { data: data, err: err }
    }

    function useKline(code, period) {
      const [kline, setKline] = useState(null)
      useEffect(() => {
        if (!code) {
          setKline(null)
          return undefined
        }
        let alive = true
        setKline(null)
        fetch(API + '?op=kline&code=' + encodeURIComponent(code) + '&period=' + period, { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => {
            if (alive && j && j.ok) setKline(j)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [code, period])
      return kline
    }

    function useMonths(variety) {
      const [list, setList] = useState([])
      useEffect(() => {
        if (!variety) {
          setList([])
          return undefined
        }
        let alive = true
        const timer = setTimeout(() => {
          fetch(API + '?op=months&variety=' + encodeURIComponent(variety), { cache: 'no-store' })
            .then((r) => r.json())
            .then((j) => {
              if (alive && j && j.ok && Array.isArray(j.months)) setList(j.months)
            })
            .catch(() => {})
        }, 280)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [variety])
      return list
    }

    /** 量出输入框所在盒子的宽度（随窗口变化），用于行情带与弹窗的自适应。 */
    function useComposerWidth(active) {
      const [width, setWidth] = useState(null)
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const measure = () => {
          if (!alive) return
          const editable = document.querySelector('textarea, [contenteditable="true"]')
          if (!editable) return
          let el = editable
          let best = null
          for (let i = 0; i < 6 && el; i++) {
            const cs = window.getComputedStyle(el)
            const radius = parseFloat(cs.borderTopLeftRadius) || 0
            const w = el.getBoundingClientRect().width
            if (radius >= 8 && w > 240) best = el
            el = el.parentElement
          }
          const box = best || editable.parentElement || editable
          const w = Math.round(box.getBoundingClientRect().width)
          if (w > 200 && w <= window.innerWidth) setWidth((prev) => (prev === w ? prev : w))
        }
        const t1 = setTimeout(measure, 120)
        const t2 = setTimeout(measure, 600)
        let ro = null
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(measure)
          const editable = document.querySelector('textarea, [contenteditable="true"]')
          if (editable && editable.parentElement) ro.observe(editable.parentElement)
        }
        window.addEventListener('resize', measure)
        return () => {
          alive = false
          clearTimeout(t1)
          clearTimeout(t2)
          if (ro) ro.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [active])
      return width
    }

    /* ───────────── 新会话落地页识别 ─────────────
     * 落地页有一个大标题 + 居中的输入框，行情带挂在上面会被撑到很宽、与内容互相压叠。
     * 这里用两个**界面自身**的稳定特征判断（不依赖 DSH 内部 class，改版后也不会崩）：
     *   1) 输入框 placeholder 是落地页那句（"描述你想要构建的内容…"）
     *   2) 页面文本里出现落地页标题
     * 命中任意一条就视为落地页 → 不显示行情带，也停止拉取。
     */
    const LANDING_PLACEHOLDER = '描述你想要构建'
    const LANDING_TITLE = '探索未至之境'

    const isLandingPage = () => {
      if (typeof document === 'undefined') return false
      const editable = document.querySelector('textarea, [contenteditable="true"]')
      if (editable) {
        const ph =
          editable.getAttribute('placeholder') ||
          editable.getAttribute('aria-placeholder') ||
          editable.getAttribute('data-placeholder') ||
          ''
        // 有 placeholder 就直接按它判定，避免每次变化都去扫整页文本（流式输出时很贵）
        if (ph) return String(ph).indexOf(LANDING_PLACEHOLDER) >= 0
      }
      const body = document.body
      if (!body) return false
      return String(body.innerText || '').indexOf(LANDING_TITLE) >= 0
    }

    function useLandingPage() {
      const [landing, setLanding] = useState(() => {
        try {
          return isLandingPage()
        } catch (e) {
          return false
        }
      })
      useEffect(() => {
        if (typeof document === 'undefined' || !document.body) return undefined
        let timer = null
        const check = () => {
          timer = null
          let next = false
          try {
            next = isLandingPage()
          } catch (e) {
            next = false
          }
          setLanding((prev) => (prev === next ? prev : next))
        }
        const schedule = () => {
          if (timer) return
          timer = setTimeout(check, 250)
        }
        let observer = null
        if (typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
        }
        check()
        return () => {
          if (observer) observer.disconnect()
          if (timer) clearTimeout(timer)
        }
      }, [])
      return landing
    }

    /* ───────────── 格式化 ───────────── */

    const fmtNum = (v, digits) => {
      if (!Number.isFinite(v)) return '—'
      const opts =
        typeof digits === 'number'
          ? { minimumFractionDigits: digits, maximumFractionDigits: digits }
          : { maximumFractionDigits: 2 }
      return v.toLocaleString('en-US', opts)
    }
    const arrowOf = (v) => (v > 0 ? '↑' : v < 0 ? '↓' : '—')

    /** 涨跌幅文字：用 +/- 表示正负（不再是上下箭头）。 */
    const signedPct = (v) => {
      if (!Number.isFinite(v)) return '—'
      const sign = v > 0 ? '+' : v < 0 ? '-' : ''
      return sign + Math.abs(v).toFixed(2) + '%'
    }

    /**
     * 「较上次刷新」的箭头档位：按**每个合约自身**的典型跳动幅度自适应，
     * 让股指（IC/IM 6 秒常见 5~13bp）与商品（常见 1~5bp）的敏感度一致。
     *
     *   ratio = 本次相对幅度 / 该合约近期典型跳动（EMA 平滑）
     *   ratio ≥ 1 → 1 个箭头；≥ 2.5 → 2 个；≥ 5 → 3 个
     *   rel < 0.6bp → 视为"平"（界面显示 →）
     *
     * 状态存在模块级 Map 里（不随组件挂载/切换会话丢失），断档 >30s 不计跳变。
     */
    const TICK_STATE = new Map()
    const TICK_MIN_REL = 0.00006
    const TICK_GAP_MS = 30000

    const tickLevelFor = (code, price) => {
      const now = Date.now()
      const prev = TICK_STATE.get(code)
      if (!code || !Number.isFinite(price) || price <= 0) return { level: 0, dir: null }
      if (!prev || !Number.isFinite(prev.price) || now - prev.at > TICK_GAP_MS) {
        TICK_STATE.set(code, { price: price, at: now, typical: prev ? prev.typical : 0 })
        return { level: 0, dir: null }
      }
      const rel = Math.abs(price - prev.price) / Math.abs(prev.price)
      const typical = prev.typical > 0 ? prev.typical * 0.88 + rel * 0.12 : rel || 0.0001
      TICK_STATE.set(code, { price: price, at: now, typical: typical })
      if (rel < TICK_MIN_REL || typical <= 0) return { level: 0, dir: null }
      const ratio = rel / Math.max(typical, TICK_MIN_REL)
      const level = ratio >= 5 ? 3 : ratio >= 2.5 ? 2 : 1
      return { level: level, dir: price > prev.price ? 'up' : price < prev.price ? 'down' : null }
    }
    // 中金所名字太长（中证500指数期货 → 中证500、5年期国债期货 → 5年国债）
    const CFFEX_SHORT = {
      IF0: '沪深300',
      IH0: '上证50',
      IC0: '中证500',
      IM0: '中证1000',
      TS0: '2年国债',
      TF0: '5年国债',
      T0: '10年国债',
      TL0: '30年国债',
    }

    /** 展示用短名：中金所用简称，月份合约附带月份，其余沿用目录名。 */
    const displayName = (code, row, catalog) => {
      const variety = String(code || '').replace(/\d+$/, '')
      const month = /^[A-Z]{1,3}\d{3,4}$/.test(String(code || '')) ? String(code).slice(variety.length) : ''
      const cffex = CFFEX_SHORT[variety + '0']
      if (cffex) return cffex + (month ? ' ' + month.slice(-2) : '')
      const raw = shortName(code, row, catalog)
      return raw
    }

    const shortName = (code, row, catalog) => {
      if (row && row.name) return String(row.name).replace(/连续$/, '')
      const hit = Array.isArray(catalog) ? catalog.find((c) => c.code === code) : null
      return hit ? hit.label : code
    }
    const clockText = (ms) => {
      if (!ms) return ''
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    /** 用 canvas 精确测量文本宽度（12px，与行情带同字体），无 DOM 时退化估算。 */
    let textCtx = null
    const measureText = (text, font) => {
      const str = String(text == null ? '' : text)
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return str.length * 8
      if (!textCtx) {
        const canvas = document.createElement('canvas')
        textCtx = canvas.getContext('2d')
      }
      textCtx.font = font || '12px -apple-system, "PingFang SC", sans-serif'
      return textCtx.measureText(str).width
    }

    /** 统一格宽：由"最长合约名 + 最宽价格 + 最宽涨跌幅 + 内边距"算出来，保证每格等宽且不裁字。 */
    const RIBBON_FONT = '12px -apple-system, "PingFang SC", sans-serif'
    const cellWidthFor = (codes, catalog) => {
      const names = (codes || []).map((code) => displayName(code, null, catalog))
      const nameW = Math.max(44, ...names.map((n) => measureText(n, RIBBON_FONT)))
      const priceW = Math.max(44, measureText('108,800', RIBBON_FONT))
      const pctW = Math.max(46, measureText('+99.99%', RIBBON_FONT))
      // 名称 + 间距 + 价格 + 间距 + 涨跌幅 + 左右内边距
      const raw = nameW + 7 + priceW + 5 + pctW + 5 + 22 + 12
      return Math.ceil(raw / 4) * 4
    }

    /* ───────────── 样式 ───────────── */

    const STYLE = `
      .fr-ribbon{position:relative;display:flex;align-items:center;justify-content:center;width:100%;min-width:0;
        margin:0 auto;font-size:12px;line-height:1.6;white-space:nowrap;user-select:none;
        color:var(--dsw-alias-label-tertiary);overflow:hidden;padding:3px 6px 1px}
      .fr-cells{display:flex;align-items:center;justify-content:center;width:100%;min-width:0;
        overflow:hidden;contain:layout paint}
      .fr-cell{flex:0 0 auto;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
        overflow:hidden;cursor:pointer;border-radius:5px;padding:0 6px;outline:none;position:relative}
      .fr-cell:hover,.fr-cell:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
      .fr-cell+.fr-cell{border-left:1px solid var(--dsw-alias-border-l2)}
      .fr-slot{position:relative;display:flex;align-items:center;height:1.55em;overflow:hidden}
      .fr-layer{display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap;
        backface-visibility:hidden}
      .fr-layer-out{position:absolute;left:0;right:0;top:0;bottom:0}
      .fr-anim-fade .fr-layer-in{animation:fr-fadein .46s ease both}
      .fr-anim-fade .fr-layer-out{animation:fr-fadeout .46s ease both}
      .fr-anim-slide .fr-layer-in{animation:fr-slidein .46s cubic-bezier(.22,.61,.36,1) both}
      .fr-anim-slide .fr-layer-out{animation:fr-slideout .46s cubic-bezier(.22,.61,.36,1) both}
      @keyframes fr-fadein{from{opacity:0}to{opacity:1}}
      @keyframes fr-fadeout{from{opacity:1}to{opacity:0}}
      @keyframes fr-slidein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
      @keyframes fr-slideout{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-6px)}}
      @media (prefers-reduced-motion: reduce){.fr-layer{animation:none!important}}
      .fr-name{color:var(--dsw-alias-label-tertiary)}
      .fr-last{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .fr-pct{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-secondary);
        font-variant-numeric:tabular-nums}
      .fr-arrow{font-size:11px;color:var(--dsw-alias-label-tertiary);opacity:.95}
      .fr-tick{display:inline-block;width:22px;flex:none;text-align:center;font-size:10.5px;
        line-height:1.2;letter-spacing:-1px;color:var(--dsw-alias-label-tertiary);opacity:.9}
      .fr-tick-flat{color:var(--dsw-alias-label-quaternary);opacity:.5;letter-spacing:0}
      .fr-tick-strong{color:var(--dsw-alias-state-warn-primary,#b45309);font-weight:600;opacity:1;
        letter-spacing:-.5px}
      .fr-pop{position:fixed;z-index:70;left:0;top:auto;
        max-height:min(74vh,560px);overflow:auto;border-radius:12px;padding:10px 12px 12px;
        font-size:12px;color:var(--dsw-alias-label-secondary);
        background-color:var(--dsw-alias-bg-l1);
        background-image:linear-gradient(0deg,var(--dsw-alias-bg-l1),var(--dsw-alias-bg-l1));
        border:1px solid var(--dsw-alias-border-l1);
        box-shadow:0 14px 36px rgba(0,0,0,.18);
        -webkit-backdrop-filter:blur(14px) saturate(1.1);backdrop-filter:blur(14px) saturate(1.1);
        transition:opacity .12s ease}
      .fr-pop-head{display:flex;align-items:baseline;gap:8px;padding-bottom:8px;
        border-bottom:1px solid var(--dsw-alias-border-l2)}
      .fr-pop-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:12.5px}
      .fr-pop-meta{color:var(--dsw-alias-label-quaternary);font-size:10.5px;font-variant-numeric:tabular-nums}
      .fr-spacer{flex:1}
      .fr-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;
        padding:1px 7px;border-radius:6px;cursor:pointer;line-height:1.6}
      .fr-btn:hover,.fr-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary);outline:none}
      .fr-cols{display:grid;grid-template-columns:1fr 88px 72px 76px;gap:8px;padding:6px 8px 2px;
        color:var(--dsw-alias-label-quaternary);font-size:10.5px}
      .fr-cols span:nth-child(n+2){text-align:right}
      .fr-table{display:flex;flex-direction:column}
      .fr-row{display:grid;grid-template-columns:1fr 88px 72px 76px;gap:8px;align-items:center;padding:4px 8px;
        border-radius:7px;cursor:pointer;font-variant-numeric:tabular-nums}
      .fr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .fr-row.is-sel{background:var(--dsw-alias-bg-l2)}
      .fr-row .fr-c{text-align:right}
      .fr-code{color:var(--dsw-alias-label-quaternary);font-size:10.5px;margin-left:6px}
      .fr-charts{display:flex;flex-direction:column;gap:3px;flex:none}
      .fr-chart-row{display:flex;align-items:center;gap:6px}
      .fr-chart-tag{width:30px;flex:none;font-size:9.5px;color:var(--dsw-alias-label-quaternary);
        letter-spacing:.3px;text-align:right}
      .fr-detail{margin-top:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;
        display:flex;gap:12px;align-items:center;
        background-color:var(--dsw-alias-bg-l2);
        background-image:linear-gradient(0deg,var(--dsw-alias-bg-l2),var(--dsw-alias-bg-l2))}
      .fr-split{width:1px;align-self:stretch;background:var(--dsw-alias-border-l2)}
      .fr-stats{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:baseline;
        font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0;flex:1}
      .fr-stats i{font-style:normal;color:var(--dsw-alias-label-quaternary);font-size:10.5px;white-space:nowrap}
      .fr-stats b{color:var(--dsw-alias-label-secondary);font-weight:500;font-variant-numeric:tabular-nums;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fr-foot{margin-top:8px;color:var(--dsw-alias-label-quaternary);font-size:10.5px}
      .fr-empty{padding:16px 4px;color:var(--dsw-alias-label-quaternary);font-size:11.5px}
      .fr-set{display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
      .fr-set-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}
      .fr-set-desc{color:var(--dsw-alias-label-quaternary);font-size:11px;margin-top:2px}
      .fr-field{display:flex;align-items:center;gap:10px;font-size:11.5px}
      .fr-label{width:72px;flex:none;color:var(--dsw-alias-label-tertiary)}
      .fr-input,.fr-select{background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l1);
        color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 9px;font:inherit;font-size:11.5px}
      .fr-input{flex:1;min-width:0}
      .fr-input:focus,.fr-select:focus{outline:none;border-color:var(--dsw-alias-label-quaternary)}
      .fr-chips{display:flex;flex-wrap:wrap;gap:5px;min-width:0;touch-action:none}
      .fr-chip{display:inline-flex;align-items:center;gap:2px;background:var(--dsw-alias-bg-l2);
        border-radius:6px;padding:2px 4px 2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);
        white-space:nowrap;cursor:grab}
      .fr-chip.is-drag{background:var(--dsw-alias-interactive-bg-hover);
        color:var(--dsw-alias-label-primary);cursor:grabbing;
        box-shadow:0 4px 14px rgba(0,0,0,.22);transform:scale(1.04);z-index:1;position:relative}
      .fr-grip{color:var(--dsw-alias-label-quaternary);font-size:9px;letter-spacing:-1.5px;cursor:grab}
      .fr-chip em{font-style:normal;color:var(--dsw-alias-label-quaternary);font-size:10px;margin-left:2px}
      .fr-chip b{font-weight:400;cursor:pointer;color:var(--dsw-alias-label-quaternary);padding:0 3px;
        border-radius:4px;line-height:1.5;opacity:0;transition:opacity .12s ease}
      .fr-chip:hover b,.fr-chip:focus-within b{opacity:1}
      .fr-chip b:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      @media (hover:none){.fr-chip b{opacity:1}}
      .fr-results{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);
        border-radius:7px;overflow:hidden}
      .fr-result{display:flex;gap:8px;align-items:center;padding:4px 9px;font-size:11.5px;cursor:pointer}
      .fr-result:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .fr-result em{font-style:normal;color:var(--dsw-alias-label-quaternary);width:42px;flex:none}
      .fr-hint{color:var(--dsw-alias-label-quaternary);font-size:10.5px}
      .fr-side{display:flex;flex-direction:column;gap:4px;width:100%;padding:6px 8px 7px;
        border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
        background-color:var(--dsw-alias-bg-l1);
        background-image:linear-gradient(0deg,var(--dsw-alias-bg-l1),var(--dsw-alias-bg-l1));
        font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary);user-select:none}
      .fr-side-head{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.5px;
        color:var(--dsw-alias-label-quaternary)}
      .fr-side-head b{font-weight:500;color:var(--dsw-alias-label-tertiary);letter-spacing:0}
      .fr-side-view{position:relative;overflow:hidden;height:76px;
        -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%);
        mask-image:linear-gradient(180deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%)}
      .fr-side-track{display:flex;flex-direction:column;will-change:transform}
      .fr-side-track.fr-side-loop{animation:fr-side-up var(--fr-side-dur,48s) linear infinite}
      .fr-side-view:hover .fr-side-track.fr-side-loop{animation-play-state:paused}
      @keyframes fr-side-up{from{transform:translateY(0)}to{transform:translateY(-50%)}}
      .fr-side-run{display:flex;flex-direction:column}
      .fr-side-row{display:flex;align-items:baseline;gap:5px;padding:1px 2px;border-radius:4px;cursor:pointer;
        font-variant-numeric:tabular-nums;white-space:nowrap}
      .fr-side-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .fr-side-row .fr-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .fr-side-row .fr-last{flex:none}
      .fr-side-row .fr-pct{flex:none;min-width:48px;justify-content:flex-end}
    `

    function Styles() {
      return h('style', { 'data-fr-style': 'futures-ribbon' }, STYLE)
    }

    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[futures-ribbon] 渲染异常，已降级隐藏：', err && err.message)
        }
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /* ───────────── 翻牌数字 ───────────── */

    /** 客户端计算 TRIX 序列（不依赖宿主），返回 { line, signal, value, signalValue, dir }。 */
    function computeTrixSeries(closes, period, signalPeriod) {
      const empty = { line: [], signal: [], value: null, signalValue: null, dir: 'flat' }
      if (!Array.isArray(closes) || closes.length < period * 3 + signalPeriod + 2) return empty
      const ema = (src, n) => {
        const k = 2 / (n + 1)
        const out = []
        let prev = src[0]
        out.push(prev)
        for (let i = 1; i < src.length; i++) {
          prev = src[i] * k + prev * (1 - k)
          out.push(prev)
        }
        return out
      }
      const e3 = ema(ema(ema(closes, period), period), period)
      const line = []
      for (let i = 1; i < e3.length; i++) {
        const prev = e3[i - 1]
        line.push(prev ? ((e3[i] - prev) / prev) * 100 : 0)
      }
      if (line.length < signalPeriod) return empty
      const sig = ema(line, signalPeriod)
      const value = line[line.length - 1]
      const signalValue = sig[sig.length - 1]
      return {
        line: line,
        signal: sig,
        value: value,
        signalValue: signalValue,
        dir: value > signalValue ? 'up' : value < signalValue ? 'down' : 'flat',
      }
    }

    /** 双线迷你图：TRIX（实线）+ 信号线（细线）+ 零轴（虚线）+ 末端点。纯单色。 */
    function TrixChart(props) {
      const line = (props.line || []).slice(-(props.count || 60))
      const sig = (props.signal || []).slice(-(props.count || 60))
      if (line.length < 2) return h('span', { className: 'fr-hint' }, 'K 线不足，无法计算 TRIX')
      const width = props.width || 190
      const height = props.height || 34
      const all = line.concat(sig)
      let min = Math.min.apply(null, all)
      let max = Math.max.apply(null, all)
      if (min > 0) min = 0
      if (max < 0) max = 0
      const span = max - min || 1
      const y = (v) => height - 2 - ((v - min) / span) * (height - 4)
      const x = (i, n) => (i / Math.max(1, n - 1)) * width
      const path = (arr) =>
        arr.map((v, i) => (i === 0 ? 'M' : 'L') + x(i, arr.length).toFixed(2) + ',' + y(v).toFixed(2)).join(' ')
      const zeroY = y(0)
      const lastX = x(line.length - 1, line.length)
      return h(
        'svg',
        {
          viewBox: '0 0 ' + width + ' ' + height,
          width: width,
          height: height,
          preserveAspectRatio: 'none',
          style: { display: 'block', flex: 'none', overflow: 'visible' },
        },
        h('line', {
          x1: 0,
          y1: zeroY,
          x2: width,
          y2: zeroY,
          stroke: 'var(--dsw-alias-label-quaternary)',
          strokeWidth: 0.6,
          strokeDasharray: '2 3',
          opacity: 0.35,
        }),
        h('path', {
          d: path(sig),
          fill: 'none',
          stroke: 'var(--dsw-alias-label-tertiary)',
          strokeWidth: 0.9,
          opacity: 0.5,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: path(line),
          fill: 'none',
          stroke: 'var(--dsw-alias-label-secondary)',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          opacity: 0.95,
        }),
        h('circle', { cx: lastX, cy: y(line[line.length - 1]), r: 1.8, fill: 'var(--dsw-alias-label-primary)' }),
      )
    }

    const trixVerdict = (dir) =>
      dir === 'up' ? '多（TRIX 在信号线上方）' : dir === 'down' ? '空（TRIX 在信号线下方）' : '中性（与信号线黏合）'

    function Sparkline(props) {
      const bars = props.bars
      if (!bars || bars.length < 2) return h('span', { className: 'fr-hint' }, '无 K 线')
      const width = props.width || 190
      const height = props.height || 38
      const data = bars.slice(-(props.count || 60))
      const vals = data.map((b) => b.c)
      const min = Math.min.apply(null, vals)
      const max = Math.max.apply(null, vals)
      const span = max - min || 1
      const pts = vals
        .map((v, i) => ((i / (vals.length - 1)) * width).toFixed(2) + ',' + (height - 2 - ((v - min) / span) * (height - 4)).toFixed(2))
        .join(' ')
      return h(
        'svg',
        {
          viewBox: '0 0 ' + width + ' ' + height,
          width: width,
          height: height,
          preserveAspectRatio: 'none',
          style: { display: 'block', flex: 'none' },
        },
        h('polyline', {
          points: pts,
          fill: 'none',
          stroke: 'var(--dsw-alias-label-tertiary)',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          opacity: 0.85,
        }),
      )
    }

    /* ───────────── 表格 / 详情 ───────────── */

    function MarketTable(props) {
      const cfg = props.cfg
      const rows = props.rows || []
      const catalog = Array.isArray(props.catalog) ? props.catalog : []
      const byCode = {}
      rows.forEach((r) => {
        byCode[r.code] = r
      })
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'fr-cols' },
          h('span', null, '品种'),
          h('span', null, '最新'),
          h('span', null, '涨跌'),
          h('span', null, '涨跌幅'),
        ),
        h(
          'div',
          { className: 'fr-table' },
          cfg.codes.map((code) => {
            const r = byCode[code]
            const live = r && !r.stale
            return h(
              'div',
              {
                key: code,
                className: 'fr-row' + (props.selected === code ? ' is-sel' : ''),
                onClick: () => props.onPick && props.onPick(code),
                title: r && r.date ? '交易日 ' + r.date : code,
              },
              h('span', null, displayName(code, r, catalog), h('span', { className: 'fr-code' }, code)),
              h('span', { className: 'fr-c' }, live ? fmtNum(r.last) : '—'),
              h(
                'span',
                { className: 'fr-c' },
                live ? h(React.Fragment, null, h('span', { className: 'fr-arrow' }, arrowOf(r.change)), fmtNum(Math.abs(r.change))) : '—',
              ),
              h('span', { className: 'fr-c' }, live ? signedPct(r.pct) : '—'),
            )
          }),
        ),
      )
    }

    const trendText = (t) => (t === 'up' ? '多头排列' : t === 'down' ? '空头排列' : t === 'mixed' ? '均线纠缠' : '—')

    function Detail(props) {
      const kline = useKline(props.code, '5')
      const r = props.row
      const live = r && !r.stale
      const bars = (kline && kline.bars) || []
      const closes = bars.map((b) => b.c)
      const trix = React.useMemo(() => computeTrixSeries(closes, 12, 9), [props.code, bars.length])
      const hasTrix = trix.line.length > 2

      return h(
        'div',
        { className: 'fr-detail' },
        h(
          'div',
          { className: 'fr-charts' },
          h(
            'div',
            { className: 'fr-chart-row' },
            h('span', { className: 'fr-chart-tag' }, '价格'),
            h(Sparkline, { bars: bars, width: 176, height: 30 }),
          ),
          h(
            'div',
            { className: 'fr-chart-row' },
            h('span', { className: 'fr-chart-tag' }, 'TRIX'),
            h(TrixChart, { line: trix.line, signal: trix.signal, width: 176, height: 30 }),
          ),
        ),
        h('div', { className: 'fr-split' }),
        h(
          'div',
          { className: 'fr-stats' },
          h('i', null, 'TRIX 判断'),
          h('b', null, hasTrix ? trixVerdict(trix.dir) : '数据不足'),
          h('i', null, 'TRIX12 / 信号'),
          h(
            'b',
            null,
            hasTrix ? trix.value.toFixed(3) + ' / ' + trix.signalValue.toFixed(3) + (trix.dir === 'up' ? ' ↑' : trix.dir === 'down' ? ' ↓' : '') : '—',
          ),
          h('i', null, '开/高/低'),
          h('b', null, live ? fmtNum(r.open) + ' / ' + fmtNum(r.high) + ' / ' + fmtNum(r.low) : '—'),
          h('i', null, '持仓 / 成交量'),
          h('b', null, live ? fmtNum(r.hold, 0) + ' / ' + fmtNum(r.volume, 0) : '—'),
          h('i', null, '均线'),
          h('b', null, kline ? (kline.ma && kline.ma[5] != null ? 'MA5 ' + fmtNum(kline.ma[5]) + ' · ' : '') + trendText(kline.trend) : '加载中'),
          h('i', null, '交易日'),
          h('b', null, live && r.date ? r.date : '—'),
        ),
      )
    }

    /* ───────────── 浮层（点击打开，展示被点中的合约） ───────────── */

    let ribbonEl = null

    function Popover(props) {
      const pop = usePop()
      const cfg = props.cfg
      const availW = props.width || null
      const host = props.host || 'dock'
      const catalog = useCatalog()
      const [pos, setPos] = useState(null)
      const popRef = useRef(null)
      const rows = props.rows || []
      const byCode = {}
      rows.forEach((r) => {
        byCode[r.code] = r
      })
      const selected = pop.selected || (cfg.codes && cfg.codes[0]) || 'RU0'

      useEffect(() => {
        if (!pop.open) {
          setPos(null)
          return undefined
        }
        const place = () => {
          const el = popRef.current
          const vh = window.innerHeight
          const vw = window.innerWidth
          const hgt = el ? el.offsetHeight : 0
          const ribbon = ribbonEl
          const rect = ribbon ? ribbon.getBoundingClientRect() : null
          // 宽度：跟随输入框宽度（留一点余量），并限制在 320~600
          const w = Math.max(320, Math.min(600, Math.round((availW || vw * 0.6) - 8)))
          // 水平：居中于行情带（而不是视口），并夹在视口内
          const centerX = rect ? rect.left + rect.width / 2 : vw / 2
          const left = Math.max(8, Math.min(centerX - w / 2, vw - w - 8))
          const leftSide = rect ? Math.max(8, Math.min(rect.right + 8, vw - w - 8)) : left
          if (host === 'sidebar') {
            // 侧栏模式：展开到面板右侧，与面板底对齐
            const maxHeight = Math.round(Math.min(vh - 32, 520))
            const bottom = Math.round(Math.max(12, Math.min(vh - rect.bottom, vh - maxHeight - 8)))
            setPos((prev) => (prev && prev.left === leftSide && prev.bottom === bottom ? prev : { left: leftSide, bottom: bottom, width: w, maxHeight: maxHeight }))
            return
          }
          // 垂直：底边贴行情带上方 8px；用"最大高度"限制，而不是用高度去夹底边
          const spaceAbove = rect ? rect.top - 12 : vh - 140
          const roomy = spaceAbove >= 180
          const maxHeight = Math.round(roomy ? spaceAbove : Math.max(160, vh - 32))
          const bottom = Math.round(roomy ? vh - rect.top + 8 : 16)
          setPos((prev) =>
            prev && prev.left === left && prev.bottom === bottom && prev.width === w && prev.maxHeight === maxHeight
              ? prev
              : { left: left, bottom: bottom, width: w, maxHeight: maxHeight },
          )
        }
        const t1 = setTimeout(place, 0)
        const t2 = setTimeout(place, 140)
        window.addEventListener('resize', place)
        return () => {
          clearTimeout(t1)
          clearTimeout(t2)
          window.removeEventListener('resize', place)
        }
      }, [pop.open, selected, rows.length, availW, cfg.location, host])

      if (!pop.open) return null
      return h(
        'div',
        {
          className: 'fr-pop',
          ref: popRef,
          style: {
            bottom: (pos ? pos.bottom : 120) + 'px',
            left: (pos ? pos.left : 12) + 'px',
            width: (pos ? pos.width : 380) + 'px',
            maxHeight: (pos ? pos.maxHeight : 420) + 'px',
            opacity: pos ? 1 : 0,
          },
        },
        h(
          'div',
          { className: 'fr-pop-head' },
          h('span', { className: 'fr-pop-title' }, '行情'),
          h('span', { className: 'fr-pop-meta' }, props.sessionLabel || ''),
          h('span', { className: 'fr-pop-meta' }, clockText(props.at)),
          h('span', { className: 'fr-spacer' }),
          h('button', { className: 'fr-btn', title: '隐藏（Cmd+Shift+F）', onClick: () => writeCfg({ hidden: true }) }, '隐藏'),
          h('button', { className: 'fr-btn', title: '关闭', onClick: () => setPop({ open: false }) }, '✕'),
        ),
        props.err
          ? h('div', { className: 'fr-empty' }, '行情获取失败：' + props.err)
          : rows.length
            ? h(
                'div',
                null,
                h(MarketTable, { cfg: cfg, rows: rows, catalog: catalog, selected: selected, onPick: (code) => setPop({ selected: code }) }),
                h(Detail, { code: selected, row: byCode[selected] }),
                h('div', { className: 'fr-foot' }, '数据：新浪期货 · 每 ' + cfg.interval + ' 秒刷新 · +/− 为当日涨跌，↑↓ 为较上次刷新的变化 · 设置见「DSH 设置 → 行情带」'),
              )
            : h('div', { className: 'fr-empty' }, '加载中…'),
      )
    }

    /* ───────────── 行情带 ───────────── */

    function TickArrows(props) {
      const tick = props.tick
      // 无数据：留空
      if (tick === null || tick === undefined) return h('span', { className: 'fr-tick' })
      // 变化低于最小阈值 / 未变化：用右箭头标记"平"
      if (!tick.level) {
        return h('span', { className: 'fr-tick fr-tick-flat', title: '较上次刷新无明显变化' }, '→')
      }
      const glyph = tick.dir === 'up' ? '↑' : '↓'
      const strong = tick.level >= 3
      return h(
        'span',
        {
          className: 'fr-tick' + (strong ? ' fr-tick-strong' : ''),
          title: '较上次刷新' + (tick.dir === 'up' ? '上涨' : '下跌') + '（' + tick.level + ' 级）',
        },
        glyph.repeat(tick.level),
      )
    }

    function CellInner(props) {
      const code = props.code
      const row = props.row
      const live = row && !row.stale
      // 休市（含小休）→ 箭头完全留空；交易中但价格没动才显示"平"的 →
      const resting = !live || !!(row.session && row.session.state !== 'open')
      const tick = resting ? null : row.tick || { level: 0 }
      return h(
        React.Fragment,
        null,
        h('span', { className: 'fr-name' }, displayName(code, row, props.catalog)),
        h('span', { className: 'fr-last' }, live ? fmtNum(row.last) : '—'),
        h('span', { className: 'fr-pct' }, live ? signedPct(row.pct) : '—'),
        h(TickArrows, { tick: tick }),
      )
    }

    function Cell(props) {
      const code = props.code
      const byCode = props.byCode || {}
      const anim = props.anim || 'fade'
      const prevRef = useRef(code)
      const [outgoing, setOutgoing] = useState(null)
      const open = props.onOpen

      useEffect(() => {
        if (prevRef.current === code) return undefined
        const from = prevRef.current
        prevRef.current = code
        if (anim === 'none') {
          setOutgoing(null)
          return undefined
        }
        setOutgoing(from)
        const timer = setTimeout(() => setOutgoing(null), 500)
        return () => clearTimeout(timer)
      }, [code, anim])

      const transitioning = outgoing !== null
      const animClass = !transitioning || anim === 'none' ? '' : anim === 'slide' ? ' fr-anim-slide' : ' fr-anim-fade'

      return h(
        'span',
        {
          className: 'fr-cell',
          style: props.width ? { width: props.width + 'px' } : undefined,
          role: 'button',
          tabIndex: 0,
          title: '查看 ' + displayName(code, byCode[code], props.catalog) + '（' + code + '）详情',
          onClick: (e) => {
            e.stopPropagation()
            open(code)
          },
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              open(code)
            }
          },
        },
        h(
          'span',
          { className: 'fr-slot' + animClass },
          transitioning
            ? h(
                'span',
                { key: 'out-' + outgoing, className: 'fr-layer fr-layer-out' },
                h(CellInner, { code: outgoing, row: byCode[outgoing], catalog: props.catalog }),
              )
            : null,
          h(
            'span',
            { key: 'in-' + code, className: 'fr-layer fr-layer-in' },
            h(CellInner, { code: code, row: byCode[code], catalog: props.catalog }),
          ),
        ),
      )
    }

    function Ribbon() {
      const cfg = useCfg()
      const catalog = useCatalog()
      // 新会话落地页（大标题 + 居中输入框）不适合显示行情带，直接隐藏
      const landing = useLandingPage()
      const show = !cfg.hidden && cfg.location === 'dock' && !landing
      const { data, err } = useQuotes(cfg, show)
      const wrapRef = useRef(null)
      const boxW = useComposerWidth(show)
      const codes = cfg.codes
      // 统一格宽（由最长名称决定）＋ 按可用宽度决定格数：等宽、不裁字、不随行情抖动
      const cellW = React.useMemo(() => cellWidthFor(codes, catalog), [codes.join(','), catalog])
      const availW = boxW ? Math.max(0, boxW - 12) : 0
      const count = Math.max(1, Math.min(codes.length, availW ? Math.floor(availW / cellW) : Math.min(4, codes.length)))
      const [slots, setSlots] = useState(() => codes.slice(0, count))
      const queueRef = useRef(codes.slice(count))

      // 自选/格数变化时重置格子
      useEffect(() => {
        setSlots(codes.slice(0, count))
        queueRef.current = codes.slice(count)
      }, [codes.join(','), count])

      // 逐个切换：每个 tick 只换一个格子，换成"队列里下一个未显示的合约"
      useEffect(() => {
        const sec = Math.max(0, Number(cfg.rotateSec) || 0)
        if (!sec || cfg.hidden || cfg.location !== 'dock') return undefined
        let cell = 0
        const timer = setInterval(() => {
          setSlots((prev) => {
            const next = prev.slice()
            if (next.length === 0) return prev
            const k = cell % next.length
            cell = (cell + 1) % next.length
            if (queueRef.current.length === 0) {
              queueRef.current = codes.filter((c) => next.indexOf(c) < 0)
            }
            if (queueRef.current.length === 0) return prev
            const incoming = queueRef.current.shift()
            const outgoing = next[k]
            next[k] = incoming
            if (outgoing && codes.indexOf(outgoing) >= 0) queueRef.current.push(outgoing)
            return next
          })
        }, sec * 1000)
        return () => clearInterval(timer)
      }, [codes.join(','), count, cfg.rotateSec, cfg.hidden, cfg.location])

      if (!show) return null

      const rows = (data && data.rows) || []
      const byCode = {}
      rows.forEach((r) => {
        byCode[r.code] = r
      })

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          {
            className: 'fr-ribbon',
            ref: (el) => {
              wrapRef.current = el
              ribbonEl = el || null
            },
            style: boxW ? { maxWidth: boxW + 'px' } : undefined,
          },
          h(
            'div',
            {
              className: 'fr-cells',
              role: 'group',
              'aria-label': '行情格子，点击查看详情',
              title: '点击展开（Cmd+Shift+F 隐藏）',
              onClick: () => openWith(popState.selected),
            },
            slots.map((code, i) =>
              h(Cell, {
                key: i,
                code: code,
                byCode: byCode,
                catalog: catalog,
                anim: cfg.anim || 'fade',
                width: cellW,
                onOpen: openWith,
              }),
            ),
          ),
        ),
        h(Popover, {
          cfg: cfg,
          rows: rows,
          width: boxW,
          err: err,
          at: data && data.at,
          sessionLabel: data && data.session ? data.session.label : '',
        }),
      )
    }

    /* ───────────── 左侧栏小面板（向上滚动） ───────────── */

    function SidebarPanel() {
      const cfg = useCfg()
      const catalog = useCatalog()
      const { data } = useQuotes(cfg, !cfg.hidden && cfg.location === 'sidebar')
      const viewRef = useRef(null)
      const trackRef = useRef(null)
      const [loop, setLoop] = useState(null)

      const rows = (data && data.rows) || []
      const byCode = {}
      rows.forEach((r) => {
        byCode[r.code] = r
      })
      const codesKey = cfg.codes.join(',')

      // 内容超出一屏时无缝向上滚动（复制两份，translateY -50%）
      useEffect(() => {
        if (cfg.hidden || cfg.location !== 'sidebar') return undefined
        const measure = () => {
          const view = viewRef.current
          const track = trackRef.current
          if (!view || !track) return
          const run = track.querySelector('.fr-side-run')
          const copy = run ? run.scrollHeight : track.scrollHeight
          const h = view.clientHeight
          if (!h || copy < 20) return
          const dur = Math.max(24, Math.round(copy / 14))
          setLoop((prev) => {
            if (copy <= h + 2) return null
            if (prev && prev.dur === dur) return prev
            return { dur: dur }
          })
        }
        const t1 = setTimeout(measure, 150)
        const t2 = setTimeout(measure, 700)
        let ro = null
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(measure)
          if (viewRef.current) ro.observe(viewRef.current)
        }
        window.addEventListener('resize', measure)
        return () => {
          clearTimeout(t1)
          clearTimeout(t2)
          if (ro) ro.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [codesKey, cfg.hidden, cfg.location])

      if (cfg.hidden || cfg.location !== 'sidebar') return null

      const renderRun = (dup) =>
        h(
          'div',
          { key: dup ? 'dup' : 'main', className: 'fr-side-run', 'aria-hidden': dup ? 'true' : undefined },
          cfg.codes.map((code) => {
            const r = byCode[code]
            const live = r && !r.stale
            return h(
              'div',
              {
                key: code,
                className: 'fr-side-row',
                title: shortName(code, r, catalog) + ' ' + code + (live ? ' 最新 ' + fmtNum(r.last) : '（无数据）'),
                onClick: dup ? undefined : () => openWith(code),
              },
              h('span', { className: 'fr-name' }, displayName(code, r, catalog)),
              h('span', { className: 'fr-last' }, live ? fmtNum(r.last) : '—'),
              h('span', { className: 'fr-pct' }, live ? signedPct(r.pct) : '—'),
              h(TickArrows, {
                // 休市（含小休）留空；交易中未变动才显示"平"的 →
                tick: live && !(r.session && r.session.state !== 'open') ? r.tick || { level: 0 } : null,
              }),
            )
          }),
        )

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          {
            className: 'fr-side',
            ref: (el) => {
              ribbonEl = el || null
              viewRef.current = el ? el.querySelector('.fr-side-view') : null
            },
          },
          h(
            'div',
            { className: 'fr-side-head' },
            h('b', null, '行情'),
            h('span', { style: { flex: '1' } }),
          ),
          h(
            'div',
            { className: 'fr-side-view', ref: viewRef },
            h(
              'div',
              {
                key: codesKey + '|' + (loop ? 'loop' : 'static'),
                className: 'fr-side-track' + (loop ? ' fr-side-loop' : ''),
                ref: trackRef,
                style: loop ? { '--fr-side-dur': loop.dur + 's' } : undefined,
              },
              loop ? [renderRun(false), renderRun(true)] : renderRun(false),
            ),
          ),
        ),
        h(Popover, {
          cfg: cfg,
          rows: rows,
          host: 'sidebar',
          err: null,
          at: data && data.at,
          sessionLabel: data && data.session ? data.session.label : '',
        }),
      )
    }

    /* ───────────── 设置（DSH 设置菜单 → 行情带） ───────────── */

    function SettingsSection() {
      const cfg = useCfg()
      const catalog = useCatalog()
      const [query, setQuery] = useState('')
      const [liftCode, setLiftCode] = useState(null)
      const [confirmReset, setConfirmReset] = useState(false)
      const dragRef = useRef(null)
      const resetTimerRef = useRef(null)
      const q = query.trim()

      // 指针拖动排序：拖动过程中就实时换位，松手即结果
      useEffect(() => {
        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          if (!d.active) {
            if (Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return
            d.active = true
          }
          const el = document.elementFromPoint(e.clientX, e.clientY)
          const chip = el && el.closest ? el.closest('.fr-chip') : null
          const target = chip ? chip.getAttribute('data-code') : null
          if (!target || target === d.code) return
          const list = readCfg().codes.slice()
          const from = list.indexOf(d.code)
          const to = list.indexOf(target)
          if (from < 0 || to < 0 || from === to) return
          list.splice(from, 1)
          list.splice(to, 0, d.code)
          writeCfg({ codes: list })
        }
        const onUp = () => {
          dragRef.current = null
          setLiftCode(null)
          document.body.style.userSelect = ''
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [])

      useEffect(
        () => () => {
          if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
        },
        [],
      )

      const picked = {}
      cfg.codes.forEach((c) => {
        picked[c] = true
      })
      const m = /^([A-Za-z]{1,2})(\d{0,4})$/.exec(q)
      const varietyFromCode = m ? m[1].toUpperCase() : ''
      const digits = m ? m[2] : ''
      // 中文名（如"生猪"）也能带出该品种的具体月份
      const catHit = q && !varietyFromCode ? catalog.find((c) => String(c.label) === q || String(c.name || '').indexOf(q) >= 0) : null
      const varietyByName = catHit && /^[A-Z]{1,2}\d*$/.test(catHit.code) ? catHit.code.replace(/\d+$/, '') : ''
      const variety = varietyFromCode || varietyByName
      const monthList = useMonths(variety && digits.length < 3 ? variety : '')
      const entries = []
      // ① 主连最优先：搜索品种时最常加的就是主连，之前月份会先把 10 条名额占满，
      //    导致「碳酸锂」这种月份多的品种看不到 LC0 主连。
      if (q) {
        catalog
          .filter((c) => c.code.toLowerCase().indexOf(q.toLowerCase()) >= 0 || String(c.label).indexOf(q) >= 0)
          .forEach((c) => entries.push({ code: c.code, label: c.label, sub: c.exchangeLabel || c.exchange, tag: '主连' }))
      }
      // ② 用户直接输入了具体月份（如 LH2703）
      if (varietyFromCode && digits.length >= 3) {
        entries.push({ code: varietyFromCode + digits, label: varietyFromCode + digits, sub: '具体合约', tag: '添加' })
      }
      // ③ 该品种已挂牌的具体月份
      monthList.forEach((mo) => {
        const suffix = String(mo.code || '').slice(variety.length)
        if (!digits || suffix.indexOf(digits) === 0) {
          entries.push({ code: mo.code, label: String(mo.name || mo.code).replace(/连续$/, ''), sub: '具体合约', tag: '添加' })
        }
      })
      // ④ 加权/指数：新浪没有这类代码（LC9999 / 8888 / 888 / 000 / IDX / ZS 等写法全部无数据），故不提供
      const results = entries.filter((e) => !picked[e.code]).slice(0, 10)

      const add = (code) => {
        if (cfg.codes.indexOf(code) >= 0) return
        writeCfg({ codes: cfg.codes.concat([code]) })
        setQuery('')
      }
      const remove = (code) => writeCfg({ codes: cfg.codes.filter((c) => c !== code) })

      return h(
        'div',
        { className: 'fr-set' },
        h(
          'div',
          null,
          h('div', { className: 'fr-set-title' }, '行情带'),
          h('div', { className: 'fr-set-desc' }, '输入框上方的一行期货行情；点击品种展开明细，Cmd+Shift+F 隐藏。'),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '搜索添加'),
          h('input', {
            className: 'fr-input',
            placeholder: '主连或具体合约：RU / 橡胶 / 生猪 / LH2703',
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
        ),
        results.length
          ? h(
              'div',
              { className: 'fr-results' },
              results.map((e) =>
                h(
                  'div',
                  { key: e.code, className: 'fr-result', onClick: () => add(e.code) },
                  h('em', null, e.code),
                  h('span', null, e.label),
                  h('span', { className: 'fr-hint' }, e.sub),
                  h('span', { className: 'fr-spacer' }),
                  h('span', { className: 'fr-hint' }, e.tag),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'fr-field', style: { alignItems: 'flex-start' } },
          h('span', { className: 'fr-label', style: { paddingTop: '3px' } }, '自选'),
          h(
            'div',
            { className: 'fr-chips' },
            cfg.codes.map((code) => {
              const hit = Array.isArray(catalog) ? catalog.find((c) => c.code === code) : null
              const lifted = liftCode === code
              return h(
                'span',
                {
                  key: code,
                  className: 'fr-chip' + (lifted ? ' is-drag' : ''),
                  'data-code': code,
                  title: '按住拖动可排序',
                  onPointerDown: (e) => {
                    if (e.button !== undefined && e.button !== 0) return
                    dragRef.current = { code: code, startX: e.clientX, startY: e.clientY, active: false }
                    setLiftCode(code)
                    document.body.style.userSelect = 'none'
                  },
                },
                h('span', { className: 'fr-grip', 'aria-hidden': 'true' }, '⋮'),
                h('span', null, displayName(code, null, catalog) + ' '),
                h('em', null, code),
                h('b', { title: '移除', onPointerDown: (e) => e.stopPropagation(), onClick: () => remove(code) }, '✕'),
              )
            }),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '显示方式'),
          h(
            'select',
            { className: 'fr-select', value: cfg.location, onChange: (e) => writeCfg({ location: e.target.value }) },
            h('option', { value: 'dock' }, '输入框上方（默认）'),
            h('option', { value: 'sidebar' }, '左侧栏底部（向上滚动）'),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '刷新间隔'),
          h(
            'select',
            { className: 'fr-select', value: String(cfg.interval), onChange: (e) => writeCfg({ interval: Number(e.target.value) }) },
            [3, 5, 10, 30].map((n) => h('option', { key: n, value: String(n) }, n + ' 秒')),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '切换间隔'),
          h(
            'select',
            { className: 'fr-select', value: String(cfg.rotateSec), onChange: (e) => writeCfg({ rotateSec: Number(e.target.value) }) },
            [[0, '不切换'], [2, '2 秒'], [3, '3 秒'], [4, '4 秒'], [6, '6 秒'], [10, '10 秒']].map(([v, label]) =>
              h('option', { key: v, value: String(v) }, label),
            ),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '切换动效'),
          h(
            'select',
            { className: 'fr-select', value: cfg.anim || 'fade', onChange: (e) => writeCfg({ anim: e.target.value }) },
            h('option', { value: 'fade' }, '淡入淡出（默认）'),
            h('option', { value: 'slide' }, '上滑淡入'),
            h('option', { value: 'none' }, '无动效'),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }, '显示状态'),
          h(
            'label',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: !cfg.hidden,
              onChange: (e) => writeCfg({ hidden: !e.target.checked }),
            }),
            h('span', { className: 'fr-hint' }, cfg.hidden ? '已隐藏（Cmd+Shift+F 恢复）' : '显示中'),
          ),
        ),
        h(
          'div',
          { className: 'fr-field' },
          h('span', { className: 'fr-label' }),
          confirmReset
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'fr-hint' }, '确定恢复默认？'),
                h(
                  'button',
                  {
                    className: 'fr-btn',
                    style: { color: 'var(--dsw-alias-state-error-primary)' },
                    onClick: () => {
                      writeCfg({
                        codes: DEFAULT_CODES.slice(),
                        interval: DEFAULT_CFG.interval,
                        location: DEFAULT_CFG.location,
                        hidden: false,
                        rotateSec: DEFAULT_CFG.rotateSec,
                        anim: DEFAULT_CFG.anim,
                      })
                      setConfirmReset(false)
                      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
                    },
                  },
                  '确认恢复',
                ),
                h(
                  'button',
                  {
                    className: 'fr-btn',
                    onClick: () => {
                      setConfirmReset(false)
                      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
                    },
                  },
                  '取消',
                ),
              )
            : h(
                'button',
                {
                  className: 'fr-btn',
                  onClick: () => {
                    setConfirmReset(true)
                    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
                    resetTimerRef.current = setTimeout(() => setConfirmReset(false), 5000)
                  },
                },
                '恢复默认',
              ),
        ),
      )
    }

    /* ───────────── 插件定义 ───────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 输入框上方的一条（宿主给这一块分配宽度）
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'futures-ribbon', order: 55 }, () =>
            h(Guard, null, h(Ribbon, null)),
          ),
        )
        // 3) 左侧栏底部小面板（放在消费额度插件上方 → order 更小）
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'futures-ribbon-side', order: -2 }, () =>
            h(Guard, null, h(SidebarPanel, null)),
          ),
        )
        // 4) 设置菜单
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'futures-ribbon', order: 45, label: '行情带' }, () =>
            h(Guard, null, h(SettingsSection, null)),
          ),
        )
        // 5) 键盘：隐藏/恢复 + 关闭浮层
        ctx.effect(() => {
          const onKey = (e) => {
            const mod = e.metaKey || e.ctrlKey
            if (mod && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
              e.preventDefault()
              writeCfg({ hidden: !readCfg().hidden })
              return
            }
            if (e.key === 'Escape') setPop({ open: false })
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        })
        // 6) 多窗口同步
        ctx.effect(() => {
          const onStorage = (e) => {
            if (!e || e.key === CFG_KEY) notifyCfg()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        })
      },
    }
  },
})
