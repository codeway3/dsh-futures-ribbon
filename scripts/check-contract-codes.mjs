/**
 * 合约代码白名单自检。
 * 用法：node scripts/check-contract-codes.mjs [apiBase]
 *   无参数时只跑本地正则用例；带 apiBase（如 http://127.0.0.1:59077）时再打真实接口。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.dirname(new URL(import.meta.url).pathname)
const hostSrc = fs.readFileSync(path.join(root, '..', 'index.js'), 'utf8')

// 从宿主源码里抓出实际使用的正则，确保测的是线上那份
const matches = hostSrc.match(/\/\^\[A-Z\]\{1,3\}\(0\|\\d\{3,4\}\)\$\/|A-Z\]\{1,3\}[^\/]*\/\.test/g)
const literal = (hostSrc.match(/\^\[A-Z\]\{1,3\}\(0\|\\d\{3,4\}\)\$/) || [])[0]
if (!literal) {
  console.error('✗ 没能从 index.js 里找到合约白名单正则，请检查 index.js')
  process.exit(1)
}
const RE = new RegExp(literal)
console.log(`  宿主正则: /${literal}/`)

const mustPass = ['RU0', 'CF0', 'SR0', 'M0', 'LH0', 'I0', 'JD0', 'CU0', 'AU0', 'LH2703', 'CF2609', 'A0', 'AP2601', 'IC0', 'IF0', 'IH0', 'IM0', 'TF0', 'TS0', 'IC2612']
const mustFail = ['', 'LH', '2703', 'LH-0', 'AB', 'ABC1234X']
let bad = 0
for (const c of mustPass) {
  if (!RE.test(c)) {
    console.log(`  ✗ 应通过却被拒: ${c}`)
    bad++
  }
}
for (const c of mustFail) {
  if (RE.test(c)) {
    console.log(`  ✗ 应拒绝却通过: ${c}`)
    bad++
  }
}
console.log(`  本地用例: ${mustPass.length + mustFail.length} 条，失败 ${bad} 条`)

const api = process.argv[2]
if (!api) {
  process.exit(bad ? 1 : 0)
}
const get = async (q) => (await fetch(`${api}/futures-ribbon/api?${q}`)).json()

const h = await get('op=health')
console.log(`  运行中宿主 version=${h.version}（0.7.2 及以上才含本次修复）`)
const q1 = await get('op=quotes&codes=' + need('RU0,LH0,CF0,M0,I0'))
console.log(`  op=quotes 主连: ${q1.ok ? '✓ ' + q1.rows.filter((r) => !r.stale).length + '/' + q1.rows.length + ' 有数据' : '✗ ' + q1.error}`)
const q2 = await get('op=quotes&codes=' + need('LH2703,CF2609'))
console.log(`  op=quotes 月份: ${q2.ok ? '✓ ' + q2.rows.filter((r) => !r.stale).length + '/' + q2.rows.length + ' 有数据' : '✗ ' + q2.error}`)
const q3 = await get('op=quotes&codes=' + need('IC0,IF0,IM0,TF0'))
const cffexBad = q3.ok ? q3.rows.filter((r) => r.stale || !(r.last > 0) || !r.name || /^[\d.]+$/.test(String(r.name))) : [{}]
console.log(`  op=quotes 中金所: ${q3.ok ? (cffexBad.length === 0 ? '✓ 4/4 有数据（字段布局正确）' : '✗ 解析异常: ' + JSON.stringify(cffexBad)) : '✗ ' + q3.error}`)
const m = await get('op=months&variety=LH')
console.log(`  op=months LH: ${m.ok ? '✓ ' + m.months.map((x) => x.code).join(' ') : '✗ ' + m.error}`)

function need(v) {
  return encodeURIComponent(v)
}
if (!q1.ok || !q2.ok || !m.ok || !q3.ok || cffexBad.length) process.exit(1)
