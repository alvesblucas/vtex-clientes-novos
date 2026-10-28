// Substitui o fetch por uma OMS falsa montada a partir de MOCK_FIXTURE (JSON: { "pedidoId": {...} }).
// Uso: node --import ./test/mock-vtex.mjs scripts/clientes-novos.mjs
import fs from 'node:fs'

const orders = JSON.parse(fs.readFileSync(process.env.MOCK_FIXTURE, 'utf8'))

function full(id) {
  const o = orders[id]
  return {
    orderId: id,
    creationDate: o.creationDate,
    status: o.status,
    statusDescription: o.status,
    value: o.value || 0,
    salesChannel: o.salesChannel || '1',
    clientProfileData: o.cnpj
      ? { isCorporate: true, corporateDocument: o.cnpj, document: '' }
      : { document: o.cpf || '', email: o.email || '' },
    marketingData: o.utm || null,
  }
}

const keyOf = (o) => o.cnpj || o.cpf || o.email

globalThis.fetch = async (url) => {
  const u = new URL(url)
  const one = u.pathname.match(/\/api\/oms\/pvt\/orders\/(.+)$/)
  if (one) {
    const id = decodeURIComponent(one[1])
    return orders[id] ? Response.json(full(id)) : new Response('not found', { status: 404 })
  }
  const [, from, to] = u.searchParams.get('f_creationDate').match(/\[(.*) TO (.*)\]/)
  const q = u.searchParams.get('q')
  // MOCK_FALHA_BUSCA=400|403: a busca por cliente falha, e o corpo do erro repete o valor buscado.
  if (q && process.env.MOCK_FALHA_BUSCA) {
    return Response.json({ error: { message: `consulta inválida: q=${q}` } }, { status: Number(process.env.MOCK_FALHA_BUSCA) })
  }
  const list = Object.keys(orders)
    .filter((id) => {
      const t = Date.parse(orders[id].creationDate)
      return t >= Date.parse(from) && t <= Date.parse(to) && (!q || keyOf(orders[id]) === q)
    })
    .map((id) => ({ orderId: id, creationDate: orders[id].creationDate, status: orders[id].status }))
  return Response.json({ list, paging: { pages: 1 } })
}
