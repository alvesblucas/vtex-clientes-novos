// Classifica os pedidos de uma loja VTEX da semana anterior em cliente "novo" ou "recorrente",
// agrupados por canal de aquisição (UTM). Node 20+, sem dependências. Só lê a OMS.
//
// Novo = sem pedido não cancelado no mesmo canal de venda nos HISTORY_DAYS dias antes deste pedido.
// A OMS só devolve pedidos dos últimos 2 anos, então 730 dias é o máximo.
// O cliente é identificado pelo CPF/CNPJ (ou pelo e-mail, se o pedido não tiver documento). Esses
// dados só são usados em memória: a saída não traz nome, e-mail nem documento.
//
// Saída:
//   clientes-novos.csv  -> um pedido por linha (; e vírgula decimal, abre direto no Excel)
//   clientes-novos.md   -> resumo para o comentário da issue
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const {
  VTEX_ACCOUNT,
  VTEX_APP_KEY,
  VTEX_APP_TOKEN,
  VTEX_ENVIRONMENT = 'vtexcommercestable',
  SALES_CHANNEL = '1',
  TZ_OFFSET_HOURS = '-3',  // fuso do relatório (Brasília = -3)
  WEEK_START = '',         // AAAA-MM-DD (segunda) para refazer uma semana; vazio = semana anterior
  HISTORY_DAYS = '730',    // limite da OMS: pedidos dos últimos 2 anos
  OPEN_CONCURRENCY = '5',
  CHANNELS_FILE = fileURLToPath(new URL('../canais.json', import.meta.url)),
  CSV_FILE = 'clientes-novos.csv',
  SUMMARY_FILE = 'clientes-novos.md',
} = process.env

if (!VTEX_ACCOUNT) throw new Error('Falta VTEX_ACCOUNT (nome da conta VTEX, ex.: minhaloja)')
if (!VTEX_APP_KEY || !VTEX_APP_TOKEN) throw new Error('Faltam VTEX_APP_KEY / VTEX_APP_TOKEN')
for (const [name, value] of [['VTEX_APP_KEY', VTEX_APP_KEY], ['VTEX_APP_TOKEN', VTEX_APP_TOKEN]]) {
  if (!/^[\x21-\x7E]+$/.test(value)) throw new Error(`${name} tem espaço, quebra de linha ou caractere inválido (${value.length} caracteres). Cole de novo.`)
}
if (WEEK_START && !/^\d{4}-\d{2}-\d{2}$/.test(WEEK_START)) throw new Error(`WEEK_START inválido: ${WEEK_START}`)
if (!(Number(HISTORY_DAYS) > 0 && Number(HISTORY_DAYS) <= 730)) throw new Error(`HISTORY_DAYS deve ficar entre 1 e 730: ${HISTORY_DAYS}`)

const DAY = 86400000
const TZ = Number(TZ_OFFSET_HOURS) * 3600000
const base = `https://${VTEX_ACCOUNT}.${VTEX_ENVIRONMENT}.com.br`
const headers = {
  Accept: 'application/json',
  'X-VTEX-API-AppKey': VTEX_APP_KEY,
  'X-VTEX-API-AppToken': VTEX_APP_TOKEN,
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(base + path, { headers })
    if (res.ok) return res.json().catch(() => null)
    if ((res.status === 429 || res.status >= 500) && i < tries) { await sleep(1500 * i); continue }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GET ${path} -> ${res.status}: a chave não tem acesso. Ela precisa dos recursos "View order" e "List Orders" (OMS).`)
    }
    throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
}

// Regras de canal: lista em ordem; vale a primeira cuja expressão casar com
// "utm_source utm_medium utm_campaign".
function loadChannels() {
  const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'))
  return raw.canais.map(({ nome, padrao }) => {
    try {
      return [nome, new RegExp(padrao, 'i')]
    } catch (e) {
      throw new Error(`canais.json: expressão inválida no canal "${nome}": ${e.message}`)
    }
  })
}
const CHANNELS = loadChannels()
const unmatched = new Map() // UTMs que caíram em "Outros", listadas no log para ajustar as regras
function channel(m) {
  if (!m?.utmSource && !m?.utmCampaign) return 'Sem UTM'
  const text = [m.utmSource, m.utmMedium, m.utmCampaign].filter(Boolean).join(' ')
  const found = CHANNELS.find(([, re]) => re.test(text))?.[0]
  if (!found) unmatched.set(text, (unmatched.get(text) || 0) + 1)
  return found || 'Outros'
}

// Semana de segunda 00:00 a domingo 23:59:59 no fuso do relatório, em UTC.
function weekRange() {
  let startLocal
  if (WEEK_START) startLocal = Date.parse(`${WEEK_START}T00:00:00Z`)
  else {
    const nowLocal = new Date(Date.now() + TZ)
    const daysSinceMonday = (nowLocal.getUTCDay() + 6) % 7
    startLocal = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) - (daysSinceMonday + 7) * DAY
  }
  if (new Date(startLocal).getUTCDay() !== 1) throw new Error(`WEEK_START precisa ser uma segunda-feira: ${WEEK_START}`)
  return { start: startLocal - TZ, end: startLocal - TZ + 7 * DAY }
}

const brDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10).split('-').reverse().join('/')
const brDateTime = (ms) => `${brDate(ms)} ${new Date(ms + TZ).toISOString().slice(11, 16)}`
const money = (cents) => (cents / 100).toFixed(2).replace('.', ',')
const moneyBr = (cents) => 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// A listagem da OMS para em 30 páginas de 100; lendo um dia por vez a semana cabe com folga.
async function listOrders(from, to, extra = {}) {
  const out = []
  for (let page = 1; page <= 30; page++) {
    const q = new URLSearchParams({
      f_creationDate: `creationDate:[${new Date(from).toISOString()} TO ${new Date(to - 1).toISOString()}]`,
      salesChannelId: SALES_CHANNEL,
      per_page: '100',
      page: String(page),
      orderBy: 'creationDate,desc',
      ...extra,
    })
    const r = await api(`/api/oms/pvt/orders?${q}`)
    out.push(...(r?.list || []))
    if (!r || page >= (r.paging?.pages || 0)) break
    if (page === 30) console.warn(`Aviso: ${r.paging.pages} páginas entre ${new Date(from).toISOString()} e ${new Date(to).toISOString()}; só as 30 primeiras foram lidas.`)
  }
  return out
}

function customerKey(order) {
  const p = order.clientProfileData || {}
  const doc = String((p.isCorporate && p.corporateDocument) || p.document || '').replace(/\D/g, '')
  if (doc.length >= 11) return { key: doc, pj: doc.length === 14 }
  if (p.email && p.email.includes('@')) return { key: p.email.toLowerCase(), pj: !!p.isCorporate }
  return null
}

function sameCustomer(order, who) {
  const k = customerKey(order)
  return !!k && k.key === who.key
}

// A busca "q" da OMS é por texto; antes de chamar alguém de recorrente, abre o pedido anterior
// encontrado e confere se o documento/e-mail é o mesmo.
async function previousPurchase(order, who) {
  const created = Date.parse(order.creationDate)
  const candidates = (await listOrders(created - Number(HISTORY_DAYS) * DAY, created, { q: who.key }))
    .filter((o) => o.orderId !== order.orderId && o.status !== 'canceled' && Date.parse(o.creationDate) < created)
  for (const c of candidates.slice(0, 3)) {
    const prev = await api(`/api/oms/pvt/orders/${c.orderId}`)
    if (sameCustomer(prev, who)) {
      return { date: Date.parse(c.creationDate), channel: channel(prev.marketingData) }
    }
  }
  return null
}

const { start, end } = weekRange()
console.log(`Semana: ${brDate(start)} a ${brDate(end - 1)} | conta ${VTEX_ACCOUNT} | canal de venda ${SALES_CHANNEL} | todos os status`)

const listed = []
for (let d = start; d < end; d += DAY) listed.push(...(await listOrders(d, d + DAY)))
const ids = [...new Set(listed.map((o) => o.orderId))]
console.log(`Pedidos na semana: ${ids.length}`)

const rows = []
let done = 0, errors = 0, next = 0
async function worker() {
  while (next < ids.length) {
    const id = ids[next++]
    try {
      const order = await api(`/api/oms/pvt/orders/${id}`)
      if (String(order.salesChannel) !== SALES_CHANNEL) continue
      const who = customerKey(order)
      const prev = who ? await previousPurchase(order, who) : null
      const m = order.marketingData || {}
      rows.push({
        orderId: order.orderId,
        created: Date.parse(order.creationDate),
        status: order.statusDescription || order.status,
        canceled: order.status === 'canceled',
        value: order.value || 0,
        tipo: !who ? 'indefinido' : prev ? 'recorrente' : 'novo',
        prevDate: prev?.date,
        prevChannel: prev?.channel || '',
        channel: channel(m),
        pessoa: who ? (who.pj ? 'PJ' : 'PF') : '',
        utmSource: m.utmSource || '',
        utmMedium: m.utmMedium || '',
        utmCampaign: m.utmCampaign || '',
        coupon: m.coupon || '',
      })
    } catch (e) {
      if (/não tem acesso/.test(e.message)) throw e
      errors++
      console.error('[erro]', id, e.message)
      if (errors >= 10) throw new Error('10 pedidos com erro; abortando para não insistir contra a OMS.')
    }
    if (++done % 100 === 0) console.log(`... ${done} de ${ids.length} pedidos analisados`)
    await sleep(100)
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(OPEN_CONCURRENCY)) }, worker))
rows.sort((a, b) => a.created - b.created)

// CSV
const csvCell = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
const csv = [
  ['pedido', 'data', 'status', 'valor', 'tipo_cliente', 'canal', 'ultima_compra_anterior', 'canal_compra_anterior', 'pessoa', 'utm_source', 'utm_medium', 'utm_campaign', 'cupom'],
  ...rows.map((r) => [r.orderId, brDateTime(r.created), r.status, money(r.value), r.tipo, r.channel, r.prevDate ? brDate(r.prevDate) : '', r.prevChannel, r.pessoa, r.utmSource, r.utmMedium, r.utmCampaign, r.coupon]),
].map((l) => l.map(csvCell).join(';')).join('\r\n')
fs.writeFileSync(CSV_FILE, '﻿' + csv + '\r\n')

// Resumo: pedidos cancelados entram na contagem, mas não na receita.
function tally(list) {
  const t = { novo: { n: 0, v: 0 }, recorrente: { n: 0, v: 0 }, indefinido: { n: 0, v: 0 }, cancelados: 0 }
  for (const r of list) {
    if (r.canceled) { t.cancelados++; continue }
    t[r.tipo].n++
    t[r.tipo].v += r.value
  }
  return t
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–')
const total = tally(rows)
const valid = total.novo.n + total.recorrente.n + total.indefinido.n

function groupLines(keyOf) {
  const groups = new Map()
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) || []), r])
  return [...groups.entries()]
    .map(([k, list]) => [k, tally(list)])
    .sort((a, b) => (b[1].novo.v + b[1].recorrente.v) - (a[1].novo.v + a[1].recorrente.v))
    .map(([k, t]) => `| ${k.replace(/\|/g, '/')} | ${t.novo.n} | ${moneyBr(t.novo.v)} | ${t.recorrente.n} | ${moneyBr(t.recorrente.v)} | ${pct(t.novo.n, t.novo.n + t.recorrente.n)} |`)
}
const channelLines = groupLines((r) => r.channel)
const sourceLines = groupLines((r) => (r.utmSource ? `${r.utmSource}${r.utmCampaign ? ` / ${r.utmCampaign}` : ''}` : '(sem utm)'))

// Recorrentes: de qual canal veio a compra anterior x por onde voltaram.
const migration = new Map()
for (const r of rows) {
  if (r.canceled || r.tipo !== 'recorrente') continue
  const k = `${r.prevChannel} → ${r.channel}`
  migration.set(k, (migration.get(k) || 0) + 1)
}
const migrationLines = [...migration.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`)
const tableHead = ['| Canal | Novos | Receita novos | Recorrentes | Receita recorrentes | % novos |', '|---|---:|---:|---:|---:|---:|']
const months = Math.round(Number(HISTORY_DAYS) / 30.4)

const md = [
  `## Clientes novos x recorrentes — ${brDate(start)} a ${brDate(end - 1)}`,
  '',
  `Pedidos do canal de venda ${SALES_CHANNEL}: **${rows.length}** (${total.cancelados} cancelados, fora da receita abaixo).`,
  '',
  '| Tipo | Pedidos | % | Receita |',
  '|---|---:|---:|---:|',
  `| Novo | ${total.novo.n} | ${pct(total.novo.n, valid)} | ${moneyBr(total.novo.v)} |`,
  `| Recorrente | ${total.recorrente.n} | ${pct(total.recorrente.n, valid)} | ${moneyBr(total.recorrente.v)} |`,
  ...(total.indefinido.n ? [`| Sem CPF/e-mail | ${total.indefinido.n} | ${pct(total.indefinido.n, valid)} | ${moneyBr(total.indefinido.v)} |`] : []),
  '',
  '### Por canal',
  '',
  ...tableHead,
  ...channelLines,
  '',
  '<details><summary>Recorrentes: canal da compra anterior → canal desta compra</summary>',
  '',
  '| Anterior → agora | Pedidos |',
  '|---|---:|',
  ...migrationLines,
  '',
  '</details>',
  '',
  '<details><summary>Por UTM (utm_source / utm_campaign)</summary>',
  '',
  ...tableHead,
  ...sourceLines,
  '',
  '</details>',
  '',
  `Novo = sem compra nos ${months} meses anteriores (a VTEX guarda no máximo 2 anos de pedidos). A planilha com um`,
  'pedido por linha está no artefato **clientes-novos** desta execução; cruze com o export do Admin pela coluna `pedido`.',
  ...(unmatched.size ? ['', `UTMs sem canal (caíram em "Outros"; ajuste o \`canais.json\`): ${[...unmatched.keys()].map((k) => `\`${k}\``).join(', ')}`] : []),
  ...(errors ? ['', `⚠️ ${errors} pedido(s) não abriram e ficaram fora (ver log).`] : []),
].join('\n')
fs.writeFileSync(SUMMARY_FILE, md + '\n')

if (unmatched.size) console.log('UTMs sem canal (viraram "Outros"):', Object.fromEntries(unmatched))
console.log(`Fim. pedidos=${rows.length} novos=${total.novo.n} recorrentes=${total.recorrente.n} indefinidos=${total.indefinido.n} cancelados=${total.cancelados} erros=${errors}`)
if (errors) process.exitCode = 1
