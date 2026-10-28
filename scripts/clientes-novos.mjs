// Classifica os pedidos de uma loja VTEX da semana anterior, e do mês dessa semana até o domingo,
// em cliente "novo" ou "recorrente", agrupados por canal de aquisição (UTM). Node 20+, sem dependências. Só lê a OMS.
//
// Novo = sem pedido não cancelado no mesmo canal de venda nos HISTORY_DAYS dias antes deste pedido.
// A OMS só devolve pedidos dos últimos 2 anos, então 730 dias é o máximo.
// O cliente é identificado pelo CPF/CNPJ (ou pelo e-mail, se o pedido não tiver documento). Esses
// dados só são usados em memória: a saída não traz nome, e-mail nem documento.
//
// Saída:
//   clientes-novos.csv          -> pedidos da semana, um por linha (; e vírgula decimal, abre direto no Excel)
//   clientes-novos-mes.csv      -> a mesma planilha com os pedidos do mês
//   clientes-novos.md           -> resumo da semana e do mês para o comentário da issue
//   clientes-novos-painel.html  -> painel interativo (abre no navegador, sem instalar nada)
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
  MONTH_CSV_FILE = 'clientes-novos-mes.csv',
  PANEL_FILE = 'clientes-novos-painel.html',
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

// A busca por cliente leva o CPF/CNPJ ou e-mail na URL (q=...), e a resposta de erro da VTEX pode
// repetir esse valor. As mensagens de erro vão para o log: levam o caminho sem a query e o corpo
// com documentos e e-mails mascarados.
const mask = (text) => text.replace(/[^\s"'<>]+@[^\s"'<>]+/g, '[e-mail]').replace(/\d[\d.\/-]{9,}\d/g, '[documento]')

// 429 (limite da OMS) e 5xx: espera o Retry-After, ou 2s, 4s, 8s, 16s, 32s, antes de desistir.
async function api(path, tries = 6) {
  const shown = path.split('?')[0]
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(base + path, { headers })
    if (res.ok) return res.json().catch(() => null)
    if ((res.status === 429 || res.status >= 500) && i < tries) {
      const after = Number(res.headers.get('retry-after'))
      await sleep(after > 0 ? after * 1000 : 1000 * 2 ** i)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GET ${shown} -> ${res.status}: a chave não tem acesso. Ela precisa dos recursos "View order" e "List Orders" (OMS).`)
    }
    throw new Error(`GET ${shown} -> ${res.status} ${mask(await res.text()).slice(0, 200)}`)
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

// Mês da segunda-feira, do dia 1 até o domingo da semana (ou até o fim do mês, se a semana virar o
// mês). Ex.: a semana de 26/10 a 01/11 traz outubro fechado, de 01/10 a 31/10.
function monthRange(week) {
  const monday = new Date(week.start + TZ)
  const first = Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), 1) - TZ
  const next = Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth() + 1, 1) - TZ
  return { start: first, end: Math.min(next, week.end), closed: next <= week.end }
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

const week = weekRange()
const month = monthRange(week)
const { start, end } = week
console.log(`Semana: ${brDate(start)} a ${brDate(end - 1)} | mês: ${brDate(month.start)} a ${brDate(month.end - 1)} | conta ${VTEX_ACCOUNT} | canal de venda ${SALES_CHANNEL} | todos os status`)

// Lê do dia 1 do mês até o domingo de uma vez; a semana e o mês são recortes da mesma lista.
const listed = []
for (let d = month.start; d < end; d += DAY) listed.push(...(await listOrders(d, d + DAY)))
const ids = [...new Set(listed.map((o) => o.orderId))]
console.log(`Pedidos no período: ${ids.length}`)

const allRows = []
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
      allRows.push({
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
allRows.sort((a, b) => a.created - b.created)
const rows = allRows.filter((r) => r.created >= start)
const monthRows = allRows.filter((r) => r.created < month.end)

// CSV
const csvCell = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
function writeCsv(file, list) {
  const csv = [
    ['pedido', 'data', 'status', 'valor', 'tipo_cliente', 'canal', 'ultima_compra_anterior', 'canal_compra_anterior', 'pessoa', 'utm_source', 'utm_medium', 'utm_campaign', 'cupom'],
    ...list.map((r) => [r.orderId, brDateTime(r.created), r.status, money(r.value), r.tipo, r.channel, r.prevDate ? brDate(r.prevDate) : '', r.prevChannel, r.pessoa, r.utmSource, r.utmMedium, r.utmCampaign, r.coupon]),
  ].map((l) => l.map(csvCell).join(';')).join('\r\n')
  fs.writeFileSync(file, '﻿' + csv + '\r\n')
}
writeCsv(CSV_FILE, rows)
writeCsv(MONTH_CSV_FILE, monthRows)

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

function groupLines(keyOf, list = rows) {
  const groups = new Map()
  for (const r of list) groups.set(keyOf(r), [...(groups.get(keyOf(r)) || []), r])
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

const monthTotal = tally(monthRows)
const monthValid = monthTotal.novo.n + monthTotal.recorrente.n + monthTotal.indefinido.n
const monthName = new Date(month.start + TZ).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' })

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
  `### Mês de ${monthName}${month.closed ? ' (fechado)' : ' até agora'} — ${brDate(month.start)} a ${brDate(month.end - 1)}`,
  '',
  `Pedidos: **${monthRows.length}** (${monthTotal.cancelados} cancelados, fora da receita abaixo).`,
  '',
  '| Tipo | Pedidos | % | Receita |',
  '|---|---:|---:|---:|',
  `| Novo | ${monthTotal.novo.n} | ${pct(monthTotal.novo.n, monthValid)} | ${moneyBr(monthTotal.novo.v)} |`,
  `| Recorrente | ${monthTotal.recorrente.n} | ${pct(monthTotal.recorrente.n, monthValid)} | ${moneyBr(monthTotal.recorrente.v)} |`,
  ...(monthTotal.indefinido.n ? [`| Sem CPF/e-mail | ${monthTotal.indefinido.n} | ${pct(monthTotal.indefinido.n, monthValid)} | ${moneyBr(monthTotal.indefinido.v)} |`] : []),
  '',
  '<details><summary>Mês por canal</summary>',
  '',
  ...tableHead,
  ...groupLines((r) => r.channel, monthRows),
  '',
  '</details>',
  '',
  '### Detalhes da semana',
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
  `Novo = sem compra nos ${months} meses anteriores (a VTEX guarda no máximo 2 anos de pedidos). As planilhas com um`,
  'pedido por linha (semana e mês) estão no artefato **clientes-novos** desta execução; cruze com o export do Admin pela coluna `pedido`.',
  '',
  '📊 **Painel interativo:** no mesmo artefato, abra `clientes-novos-painel.html` no navegador (gráficos, filtros por canal e por data).',
  ...(unmatched.size ? ['', `UTMs sem canal (caíram em "Outros"; ajuste o \`canais.json\`): ${[...unmatched.keys()].map((k) => `\`${k}\``).join(', ')}`] : []),
  ...(errors ? ['', `⚠️ ${errors} pedido(s) não abriram e ficaram fora (ver log).`] : []),
].join('\n')
fs.writeFileSync(SUMMARY_FILE, md + '\n')

// Painel: HTML único com os pedidos da semana e do mês embutidos (sem nome, e-mail nem documento);
// os gráficos são montados no navegador a partir do modelo clientes-novos-painel.html.
const isoLocal = (ms) => new Date(ms + TZ).toISOString().slice(0, 10)
const painel = {
  loja: VTEX_ACCOUNT,
  periodos: {
    semana: { inicio: isoLocal(start), fim: isoLocal(end - 1) },
    mes: { nome: monthName, inicio: isoLocal(month.start), fim: isoLocal(month.end - 1), fechado: month.closed },
  },
  pedidos: allRows.map((r) => ({
    tipo: r.tipo,
    cancelado: r.canceled,
    valor: r.value,
    canal: r.channel,
    canalAnterior: r.prevChannel,
    data: isoLocal(r.created),
    utm: r.utmSource ? r.utmSource + (r.utmCampaign ? ' / ' + r.utmCampaign : '') : '',
    s: r.created >= start,
    m: r.created < month.end,
    pj: r.pessoa === 'PJ',
  })),
  gerado: brDateTime(Date.now()),
  nota: `Novo = sem compra nos ${months} meses anteriores (a VTEX guarda no máximo 2 anos de pedidos). Cancelados ficam fora de todos os números. Arquivo gerado pela automação; não contém nome, e-mail nem CPF.`,
}
const template = fs.readFileSync(new URL('./clientes-novos-painel.html', import.meta.url), 'utf8')
fs.writeFileSync(PANEL_FILE, template.replace('__DADOS__', () => JSON.stringify(painel).replace(/</g, '\\u003c')))

if (unmatched.size) console.log('UTMs sem canal (viraram "Outros"):', Object.fromEntries(unmatched))
console.log(`Mês: pedidos=${monthRows.length} novos=${monthTotal.novo.n} recorrentes=${monthTotal.recorrente.n} cancelados=${monthTotal.cancelados}`)
console.log(`Fim. pedidos=${rows.length} novos=${total.novo.n} recorrentes=${total.recorrente.n} indefinidos=${total.indefinido.n} cancelados=${total.cancelados} erros=${errors}`)
if (errors) process.exitCode = 1
