// Roda o script contra a OMS falsa (test/mock-vtex.mjs) e confere a planilha e o resumo.
// node --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function run(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clientes-novos-'))
  const log = execFileSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'test/mock-vtex.mjs')).href, path.join(root, 'scripts/clientes-novos.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      VTEX_ACCOUNT: 'lojateste',
      VTEX_APP_KEY: 'chave',
      VTEX_APP_TOKEN: 'token',
      WEEK_START: '2026-10-19',
      MOCK_FIXTURE: path.join(root, 'test/fixtures/semana.json'),
      ...env,
    },
  })
  const csv = fs.readFileSync(path.join(dir, 'clientes-novos.csv'), 'utf8').replace(/^﻿/, '').trim().split('\r\n')
  const header = csv[0].split(';')
  const rows = Object.fromEntries(csv.slice(1).map((l) => {
    const r = Object.fromEntries(l.split(';').map((v, i) => [header[i], v]))
    return [r.pedido, r]
  }))
  const md = fs.readFileSync(path.join(dir, 'clientes-novos.md'), 'utf8')
  return { log, rows, md }
}

const { log, rows, md } = run()

test('só entram pedidos da semana (segunda a domingo, horário de Brasília) e do canal de venda', () => {
  assert.deepEqual(Object.keys(rows).sort(), ['ana', 'bruno', 'cancelado', 'chat', 'empresa-1', 'empresa-2', 'sem-documento'])
})

test('cliente com compra anterior é recorrente, com data e canal da compra anterior', () => {
  assert.equal(rows.ana.tipo_cliente, 'recorrente')
  assert.equal(rows.ana.ultima_compra_anterior, '01/06/2025')
  assert.equal(rows.ana.canal_compra_anterior, 'WhatsApp')
  assert.equal(rows.ana.canal, 'WhatsApp')
})

test('compra anterior cancelada não conta', () => {
  assert.equal(rows.bruno.tipo_cliente, 'novo')
})

test('CNPJ com dois pedidos na semana: novo no primeiro, recorrente no segundo', () => {
  assert.equal(rows['empresa-1'].tipo_cliente, 'novo')
  assert.equal(rows['empresa-1'].pessoa, 'PJ')
  assert.equal(rows['empresa-2'].tipo_cliente, 'recorrente')
  assert.equal(rows['empresa-2'].ultima_compra_anterior, '22/10/2026')
})

test('pedido sem CPF/CNPJ nem e-mail fica indefinido', () => {
  assert.equal(rows['sem-documento'].tipo_cliente, 'indefinido')
})

test('canais vêm do canais.json, na ordem', () => {
  assert.equal(rows.bruno.canal, 'Google Ads')
  assert.equal(rows.chat.canal, 'Chat no site') // UTM da Weni, mas webchat vem antes de WhatsApp
  assert.equal(rows['empresa-1'].canal, 'Sem UTM')
  assert.equal(rows['empresa-2'].canal, 'Outros')
})

test('valores em reais com vírgula; cancelado fora da receita', () => {
  assert.equal(rows.ana.valor, '100,50')
  assert.match(md, /\| Novo \| 3 \| 50% \| R\$ 253,00 \|/)
  assert.match(md, /\(1 cancelados, fora da receita abaixo\)/)
})

test('UTM sem canal aparece no resumo e no log', () => {
  assert.match(md, /UTMs sem canal.*`parceiro-x`/)
  assert.match(log, /parceiro-x/)
})

test('a saída não traz CPF, CNPJ nem e-mail', () => {
  const all = JSON.stringify(rows) + md
  assert.doesNotMatch(all, /11111111111|33333333000144|@/)
})

test('semana inválida é recusada', () => {
  assert.throws(() => run({ WEEK_START: '2026-10-20' }), /segunda-feira/)
})

test('canais.json com regex inválida dá erro claro', () => {
  const bad = path.join(os.tmpdir(), 'canais-invalido.json')
  fs.writeFileSync(bad, JSON.stringify({ canais: [{ nome: 'Quebrado', padrao: '(' }] }))
  assert.throws(() => run({ CHANNELS_FILE: bad }), /expressão inválida no canal "Quebrado"/)
})
