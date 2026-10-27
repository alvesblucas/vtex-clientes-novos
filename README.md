# vtex-clientes-novos

**Quantos dos seus pedidos da semana vieram de clientes novos, e por qual canal?**

O export de pedidos do Admin da VTEX não diz se o cliente já comprou antes, e também não traz o
e-mail nem o CPF para você descobrir na planilha. Por isso fica difícil responder perguntas como:

- O Google Ads está trazendo cliente novo ou só recomprando quem já é da casa?
- Quanto do faturamento do WhatsApp vem de clientes novos?
- Quem comprou pelo app voltou pelo app ou por outro canal?

Este projeto responde isso **toda segunda-feira, sozinho**, usando o GitHub Actions. Não precisa de
servidor, banco de dados nem instalação na loja.

## O que você recebe

Um comentário numa issue do seu repositório (o GitHub manda por e-mail) com:

- pedidos e receita de **clientes novos x recorrentes** na semana;
- a mesma divisão **por canal** (Google Ads, WhatsApp, Meta Ads, E-mail, App…), montada a partir das UTMs;
- para os recorrentes, **o canal da compra anterior → o canal desta compra**;
- o detalhe por UTM.

E uma **planilha** (CSV que abre direto no Excel) com um pedido por linha:

`pedido; data; status; valor; tipo_cliente; canal; ultima_compra_anterior; canal_compra_anterior; pessoa; utm_source; utm_medium; utm_campaign; cupom`

A planilha **não traz nome, e-mail nem CPF**. Para juntar com o export do Admin, cruze pela coluna `pedido`.

Veja um exemplo com dados fictícios em [docs/exemplo-relatorio.md](docs/exemplo-relatorio.md) e
[docs/exemplo-planilha.csv](docs/exemplo-planilha.csv).

## Como funciona

1. Lê na VTEX (API de pedidos, só leitura) os pedidos da semana anterior, de segunda a domingo, no
   canal de venda escolhido. Entram todos os status; os cancelados aparecem, mas ficam fora da receita.
2. Para cada pedido, procura o mesmo cliente (CPF/CNPJ, ou e-mail se não houver documento) em pedidos
   anteriores **não cancelados**. Encontrou: **recorrente**. Não encontrou: **novo**.
3. Classifica o canal pelas UTMs, com as regras do [`canais.json`](canais.json).

> **Limite da VTEX:** a API só devolve pedidos dos **últimos 2 anos**. Então "novo" quer dizer "sem
> compra nos últimos 24 meses": quem comprou há 3 anos e voltou conta como novo.

## Como usar (15 minutos)

### 1. Crie o seu repositório a partir deste template

Clique em **Use this template → Create a new repository** e escolha **Private**.

> ⚠️ **O repositório precisa ser privado.** O relatório mostra o faturamento da sua loja. Se o
> repositório for público, a automação para com um aviso em vez de publicar.

### 2. Crie uma chave de API na VTEX, só com leitura de pedidos

No Admin da VTEX:

1. **Configurações da conta → Perfis de acesso → Novo perfil**. Dê um nome (ex.: `Leitura de pedidos`)
   e adicione só os recursos **View order** e **List Orders** (produto **OMS**). Salve.
2. **Configurações da conta → Chaves de aplicação → Gerenciar minhas chaves → Gerar nova chave**.
   Associe ao perfil criado no passo anterior.
3. Copie a **appKey** e o **appToken**. O token só aparece uma vez.

### 3. Cadastre a chave e a conta no GitHub

No seu repositório: **Settings → Secrets and variables → Actions**.

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `VTEX_APP_KEY` | a appKey |
| Secret | `VTEX_APP_TOKEN` | o appToken |
| Variable | `VTEX_ACCOUNT` | o nome da conta (o `minhaloja` de `minhaloja.myvtex.com`) |

Opcionais (aba **Variables**):

| Nome | Padrão | Para que serve |
|---|---|---|
| `CANAL_DE_VENDA` | `1` | canal de venda (sales channel) analisado |
| `DIAS_DE_HISTORICO` | `730` | quantos dias para trás contam como "já comprou" (máximo 730) |
| `RESPONSAVEL` | – | usuário do GitHub que fica como responsável pela issue |

### 4. Rode a primeira vez

**Actions → Clientes novos x recorrentes → Run workflow.** Em poucos minutos aparece a issue
"Clientes novos x recorrentes" com o resumo da semana anterior. A partir daí, roda sozinho toda
segunda às 08h15 (horário de Brasília).

Para refazer uma semana específica, preencha `week_start` com a segunda-feira dela (`AAAA-MM-DD`).

## Ajustando os canais

Cada loja nomeia as UTMs do seu jeito. Edite o [`canais.json`](canais.json): cada canal tem um nome
e uma expressão regular, que é testada contra `utm_source utm_medium utm_campaign`. **Vale a primeira
regra que casar**, então coloque as mais específicas primeiro. Por exemplo, o chat do site vem antes
do WhatsApp quando os dois usam UTMs do mesmo fornecedor.

Pedidos sem UTM ficam em **Sem UTM**. UTMs que não casam com nenhuma regra ficam em **Outros** e são
listadas no fim do resumo, para você saber o que acrescentar.

Também é assim que você junta UTMs antigas e novas do mesmo canal. Se você trocou de ferramenta de
WhatsApp, coloque as UTMs das duas na mesma regra.

## Privacidade (LGPD)

- A chave da VTEX só precisa de **leitura** de pedidos.
- CPF, CNPJ e e-mail são usados **só em memória**, para achar compras anteriores, e não aparecem em
  nenhum arquivo, log, issue ou planilha.
- A automação roda dentro do **seu** repositório privado, na **sua** conta do GitHub. Nenhum dado sai
  para terceiros.

## Custo e tempo

Uma loja com ~700 pedidos por semana leva ~4 minutos por execução. Repositório privado no plano
gratuito do GitHub tem 2.000 minutos de Actions por mês, e esta automação usa ~20.

## Rodando no seu computador

Precisa do Node 20 ou mais novo.

```bash
VTEX_ACCOUNT=minhaloja VTEX_APP_KEY=... VTEX_APP_TOKEN=... npm start
npm test   # testes com uma VTEX simulada, sem rede
```

## Contribuindo

Ideias, regras de canal novas e correções são bem-vindas: abra uma issue ou um pull request. Os
testes (`npm test`) rodam sozinhos em cada PR.

## Licença

[MIT](LICENSE)
