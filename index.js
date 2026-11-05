/**
 * 行情带 —— 宿主半。
 *
 * 职责：在本地 HTTP 服务器上注册 /futures-ribbon/api，代理新浪期货行情。
 * 之所以必须走宿主：新浪 hq.sinajs.cn 需要 Referer 头且返回 GB18030 编码，
 * 浏览器 fetch 既不能设 Referer，也拿不到正确的中文。
 *
 * 只读、纯内存缓存，不写任何存储、不写会话日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/futures-ribbon/api'

/** 版本号从 package.json 读取，避免与清单不一致。 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const SINA_REFERER = 'https://finance.sina.com.cn/'
const SINA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const SNAPSHOT_TTL_MS = 3000
const KLINE_TTL_MS = 20000
const MAX_CODES = 50

/** 新浪期货快照字段下标（与 futures-technical-analysis 技能一致）。 */
const F_NAME = 0
const F_OPEN = 2
const F_HIGH = 3
const F_LOW = 4
const F_LAST = 8
const F_PREV_SETTLE = 10
const F_HOLD = 13
const F_VOLUME = 14
const F_EXCHANGE = 15
const F_DATE = 17

/* ───────────── 交易时段表（按品种） ─────────────
 * 单位：一天内的分钟数。夜盘若跨零点，写成 [开始, 结束] 且结束 < 开始（如 [1260, 60] = 21:00→次日 01:00）。
 * 只用于"该不该去拉行情"，取不到确切夜盘时间的品种按 23:00 处理（宁可多拉一次，也不漏掉行情）。
 */
const M = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// 商品期货日盘（大商所/郑商所/上期所/能源中心基本一致）
const DAY_COMMODITY = [
  [M('09:00'), M('10:15')],
  [M('10:30'), M('11:30')],
  [M('13:30'), M('15:00')],
]
// 中金所：股指 09:30-11:30 / 13:00-15:00；国债 09:30-11:30 / 13:00-15:15
const DAY_CFFEX_INDEX = [
  [M('09:30'), M('11:30')],
  [M('13:00'), M('15:00')],
]
const DAY_CFFEX_BOND = [
  [M('09:30'), M('11:30')],
  [M('13:00'), M('15:15')],
]

const CFFEX_VARIETIES = new Set(['IF', 'IH', 'IC', 'IM', 'TF', 'TS', 'T', 'TL'])
const BOND_VARIETIES = new Set(['TF', 'TS', 'T', 'TL'])

// 夜盘到次日 02:30（上期所贵金属 + 能源中心原油）
const NIGHT_0230 = new Set(['AU', 'AG', 'SC'])
// 夜盘到次日 01:00（有色、贵金属以外的大部分上期所品种、20号胶）
const NIGHT_0100 = new Set(['CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'SS', 'NR', 'RU', 'BU', 'FU', 'SP', 'LU', 'BC'])
// 完全没有夜盘
const NO_NIGHT = new Set([
  // 中金所
  'IF', 'IH', 'IC', 'IM', 'TF', 'TS', 'T', 'TL',
  // 大商所/郑商所无夜盘品种
  'JD', 'LH', 'AP', 'CJ', 'PK', 'SF', 'SM', 'WH', 'PM', 'RI', 'LR', 'JR', 'BB', 'FB',
])

const NIGHT_23 = [M('21:00'), M('23:00')]
const NIGHT_01 = [M('21:00'), M('01:00')]
const NIGHT_0230_RANGE = [M('21:00'), M('02:30')]

const varietyOf = (code) => String(code || '').replace(/\d+$/, '').toUpperCase()

/** 某合约的日盘与夜盘时段。 */
const sessionsOf = (code) => {
  const v = varietyOf(code)
  if (CFFEX_VARIETIES.has(v)) {
    return { day: BOND_VARIETIES.has(v) ? DAY_CFFEX_BOND : DAY_CFFEX_INDEX, night: null }
  }
  const night = NO_NIGHT.has(v) ? null : NIGHT_0230.has(v) ? NIGHT_0230_RANGE : NIGHT_0100.has(v) ? NIGHT_01 : NIGHT_23
  return { day: DAY_COMMODITY, night }
}

const inRange = (mins, [a, b]) => (b > a ? mins >= a && mins < b : mins >= a || mins < b)

/**
 * 判定某合约此刻是否在交易。
 * 返回 { state: 'open'|'break'|'closed', label }。
 * 周末：周六凌晨 00:00-02:30 仍算夜盘延续（周五夜盘跨零点），周日不算。
 */
const sessionState = (code, now = new Date()) => {
  const mins = now.getHours() * 60 + now.getMinutes()
  const weekday = now.getDay() === 0 ? 7 : now.getDay() // 周一=1 … 周日=7
  const isWeekend = weekday >= 6
  const { day, night } = sessionsOf(code)

  if (!isWeekend && day.some((r) => inRange(mins, r))) return { state: 'open', label: '交易中' }

  if (night) {
    const [start, end] = night
    if (end > start) {
      if (!isWeekend && mins >= start && mins < end) return { state: 'open', label: '夜盘' }
    } else {
      // 跨零点：今天的 00:00~end 属于"昨天夜盘"
      const prevDay = weekday === 1 ? 7 : weekday - 1
      if (mins < end && prevDay >= 1 && prevDay <= 5) return { state: 'open', label: '夜盘' }
      if (!isWeekend && mins >= start) return { state: 'open', label: '夜盘' }
    }
  }

  if (isWeekend) return { state: 'closed', label: '周末休市' }
  // 小休 / 午休（中金所没有 10:15-10:30 小休，这里只用于"要不要拉行情"，误差不影响正确性）
  if (!CFFEX_VARIETIES.has(varietyOf(code))) {
    if (mins >= M('10:15') && mins < M('10:30')) return { state: 'break', label: '小休' }
  }
  if (mins >= M('11:30') && mins < M('13:30')) return { state: 'break', label: '午休' }
  return { state: 'closed', label: '休市' }
}

/**
 * 汇总一组行情的状态。各品种时段不同，所以混合时如实标成「部分交易（n/m）」，
 * 不再笼统地当作"全部交易中"。
 */
const overallSession = (rows) => {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.session)
  if (list.length === 0) return { state: 'open', label: '交易中' }
  const open = list.filter((r) => r.session.state === 'open').length
  const rest = list.filter((r) => r.session.state === 'break').length
  if (open === list.length) return { state: 'open', label: '交易中' }
  if (open > 0) return { state: 'open', label: '部分交易（' + open + '/' + list.length + '）' }
  if (rest > 0) return { state: 'break', label: '小休/午休' }
  return { state: 'closed', label: '全部休市' }
}

export const inject = ['webServer']

export function apply(ctx) {
  const catalogPath = path.join(HERE, 'data', 'catalog.json')
  let catalog = []
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  } catch (err) {
    ctx.logger?.warn?.(`futures-ribbon: 合约目录读取失败 ${String(err)}`)
  }

  const snapCache = new Map()
  const klineCache = new Map()

  const respond = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const upstream = async (url) => {
    const res = await fetch(url, {
      headers: { Referer: SINA_REFERER, 'User-Agent': SINA_UA, Accept: '*/*' },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) throw new Error(`上游 ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  const decodeGb18030 = (buf) => {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }

  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  /** 上一次拿到的行情（按合约缓存），休市时直接复用，避免重复请求新浪。 */
  const lastRowByCode = new Map()

  const fetchSnapshots = async (codes) => {
    const key = codes.join(',')
    const hit = snapCache.get(key)
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.rows

    // 只拉"正在交易"的合约；休市/小休的沿用上次结果，省掉无意义的请求
    const now = new Date()
    const trading = []
    const sessionByCode = new Map()
    for (const code of codes) {
      const st = sessionState(code, now)
      sessionByCode.set(code, st)
      if (st.state === 'open') trading.push(code)
    }

    const fresh = new Map()
    if (trading.length) {
      const url = `https://hq.sinajs.cn/list=${trading.map((c) => `nf_${c}`).join(',')}`
      const text = decodeGb18030(await upstream(url))
      for (const line of text.split('\n')) {
        const m = line.match(/var hq_str_nf_(\w+)="([^"]*)"/)
        if (!m) continue
        const code = m[1]
        const f = m[2].split(',')
        // 中金所（股指/国债 IF/IH/IC/IM/TS/TF/T/TL）快照字段顺序与商品期货完全不同：
        // 字段 0 是数字（商品是中文名），最后一个字段才是中文合约名。
        const head = String(f[0] || '').trim()
        const tail = String(f[f.length - 1] || '').trim()
        const cffex = head !== '' && Number.isFinite(Number(head)) && /[\u4e00-\u9fa5]/.test(tail)
        const name = cffex ? tail : f[F_NAME] || code
        const last = num(cffex ? f[3] : f[F_LAST])
        const prev = num(cffex ? f[13] : f[F_PREV_SETTLE])
        if (!Number.isFinite(last) || last === 0) {
          fresh.set(code, { code, name, stale: true, session: sessionByCode.get(code) })
          continue
        }
        fresh.set(code, {
          code,
          name,
          last,
          prevSettle: prev,
          change: prev ? last - prev : 0,
          pct: prev ? ((last - prev) / prev) * 100 : 0,
          open: num(cffex ? f[14] : f[F_OPEN]),
          high: num(cffex ? f[1] : f[F_HIGH]),
          low: num(cffex ? f[2] : f[F_LOW]),
          hold: num(cffex ? f[6] : f[F_HOLD]),
          volume: num(cffex ? f[4] : f[F_VOLUME]),
          exchange: cffex ? 'cffex' : f[F_EXCHANGE] || '',
          date: cffex ? f[36] || '' : f[F_DATE] || '',
          stale: false,
          session: sessionByCode.get(code),
        })
      }
    }

    const rows = codes.map((code) => {
      const st = sessionByCode.get(code) || { state: 'closed', label: '休市' }
      const freshRow = fresh.get(code)
      if (freshRow) {
        if (!freshRow.stale) lastRowByCode.set(code, freshRow)
        return freshRow
      }
      const cached = lastRowByCode.get(code)
      if (cached) return Object.assign({}, cached, { session: st, cached: true })
      return { code, name: '', stale: true, session: st, cached: true }
    })

    snapCache.set(key, { at: Date.now(), rows })
    return rows
  }

  /**
   * TRIX（三重指数平滑均线）：收盘价做三次 EMA(period)，取变化率(%)，再以 EMA(signalPeriod) 作信号线。
   * 返回 { period, signalPeriod, value, signal, prev, dir }；数据不足返回 null。
   */
  function computeTrix(closes, period, signalPeriod) {
    if (!Array.isArray(closes) || closes.length < period * 2 + signalPeriod + 2) return null
    if (closes.some((v) => !Number.isFinite(v))) return null
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
    const series = []
    for (let i = 1; i < e3.length; i++) {
      const prev = e3[i - 1]
      series.push(prev ? ((e3[i] - prev) / prev) * 100 : 0)
    }
    if (series.length < signalPeriod) return null
    const signalSeries = ema(series, signalPeriod)
    const value = series[series.length - 1]
    const signal = signalSeries[signalSeries.length - 1]
    const prev = series.length > 1 ? series[series.length - 2] : value
    return {
      period: period,
      signalPeriod: signalPeriod,
      value: Number(value.toFixed(4)),
      signal: Number(signal.toFixed(4)),
      prev: Number(prev.toFixed(4)),
      dir: value > signal ? 'up' : value < signal ? 'down' : 'flat',
    }
  }

  const fetchKline = async (code, period, type) => {
    const key = `${code}:${type}:${period}`
    const hit = klineCache.get(key)
    if (hit && Date.now() - hit.at < KLINE_TTL_MS) return hit

    const endpoint =
      type === 'daily'
        ? `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getDailyKLine?symbol=${code}`
        : `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getFewMinLine?symbol=${code}&type=${period}`
    const text = (await upstream(endpoint)).toString('utf8')
    const start = text.indexOf('([')
    const end = text.lastIndexOf(']')
    if (start < 0 || end < 0) throw new Error('K线响应格式异常')
    const raw = JSON.parse(text.slice(start + 1, end + 1))
    const bars = raw.map((b) => ({
      d: String(b.d || ''),
      o: num(b.o),
      h: num(b.h),
      l: num(b.l),
      c: num(b.c),
      v: num(b.v),
      p: num(b.p),
    }))
    const closes = bars.map((b) => b.c)
    const ma = {}
    for (const n of [5, 10, 20, 60]) {
      if (closes.length >= n) {
        const slice = closes.slice(-n)
        ma[n] = slice.reduce((a, b) => a + b, 0) / n
      } else {
        ma[n] = null
      }
    }
    const last = closes[closes.length - 1] ?? null
    let trend = 'data'
    if (last != null && ma[5] != null && ma[20] != null) {
      if (last > ma[5] && ma[5] > ma[20]) trend = 'up'
      else if (last < ma[5] && ma[5] < ma[20]) trend = 'down'
      else trend = 'mixed'
    }
    const trix = computeTrix(closes, 12, 9)
    const payload = { code, type, period, at: Date.now(), bars, ma, trend, trix }
    klineCache.set(key, { at: Date.now(), ...payload })
    return { at: Date.now(), ...payload }
  }

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const op = url.searchParams.get('op') || 'health'
    try {
      if (op === 'health') {
        respond(res, 200, { ok: true, op, catalog: catalog.length, version: VERSION })
        return
      }
      if (op === 'catalog') {
        respond(res, 200, { ok: true, op, catalog })
        return
      }
      if (op === 'quotes') {
        const raw = String(url.searchParams.get('codes') || '')
        const codes = raw
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => /^[A-Z]{1,3}(0|\d{3,4})$/.test(c))
          .slice(0, MAX_CODES)
        if (codes.length === 0) {
          respond(res, 200, { ok: false, op, error: 'codes 为空或非法' })
          return
        }
        const rows = await fetchSnapshots(codes)
        const session = overallSession(rows)
        respond(res, 200, { ok: true, op, at: Date.now(), session, rows })
        return
      }
      if (op === 'months') {
        const variety = String(url.searchParams.get('variety') || '').toUpperCase()
        if (!/^[A-Z]{1,2}$/.test(variety)) {
          respond(res, 200, { ok: false, op, error: 'variety 非法' })
          return
        }
        const now = new Date()
        const candidates = []
        for (let i = 0; i < 18; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
          const ym = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0')
          candidates.push(variety + ym)
        }
        const rows = await fetchSnapshots(candidates)
        const months = rows
          .filter((r) => !r.stale)
          .map((r) => ({ code: r.code, name: r.name, last: r.last, pct: r.pct, change: r.change, prevSettle: r.prevSettle, date: r.date }))
        respond(res, 200, { ok: true, op, variety, months })
        return
      }
      if (op === 'kline') {
        const code = String(url.searchParams.get('code') || '').toUpperCase()
        if (!/^[A-Z]{1,3}(0|\d{3,4})$/.test(code)) {
          respond(res, 200, { ok: false, op, error: 'code 非法' })
          return
        }
        const type = url.searchParams.get('type') === 'daily' ? 'daily' : 'min'
        const period = ['5', '15', '30', '60'].includes(String(url.searchParams.get('period'))) ? String(url.searchParams.get('period')) : '5'
        const data = await fetchKline(code, period, type)
        respond(res, 200, { ok: true, op, ...data })
        return
      }
      respond(res, 200, { ok: false, op, error: `未知 op: ${op}` })
    } catch (err) {
      ctx.logger?.warn?.(`futures-ribbon: ${op} 失败 ${String(err)}`)
      respond(res, 200, { ok: false, op, error: String(err?.message || err) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: handle,
    }),
  )

  ctx.logger?.info?.(`futures-ribbon: 已挂载 ${ROUTE}（目录 ${catalog.length} 个品种）`)
}
