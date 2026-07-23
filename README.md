# Ponto

Controle de ponto pessoal, 100% no navegador, hospedado de graça no **GitHub Pages** e com os dados guardados no **próprio repositório GitHub**. Sem servidor, sem banco de dados, sem mensalidade.

- **Jornada**: 8h por dia, de segunda a sexta (meta de 480 min/dia).
- **Sábado, domingo, feriado, férias, atestado e abono**: meta 0 — tudo que for trabalhado nesses dias vira **hora extra**.
- **Fuso horário**: America/Sao_Paulo (horário de Brasília), sempre.
- **Idioma**: PT-BR, layout pensado para celular (mobile-first).

## Como usar no dia a dia

1. Abra o app no navegador (a página do GitHub Pages deste repositório, ex.: `https://tarciodiniz.github.io/clockin/`). Dica: no celular, use "Adicionar à tela inicial" para virar um atalho tipo aplicativo.
2. Toque em **Bater ponto** ao chegar, sair para o almoço, voltar do almoço e ir embora. Cada toque registra uma batida com a hora atual de Brasília.
3. As batidas funcionam em **pares**: 1ª-2ª é o primeiro período trabalhado, 3ª-4ª o segundo, e assim por diante. Um número ímpar de batidas significa "período em aberto" (dia em andamento). Se o dia terminar com batida sem par, o app sinaliza a inconsistência.
4. Precisa ajustar um horário esquecido? Edite as batidas do dia diretamente no app, ou marque o dia como **feriado**, **férias**, **atestado** ou **abono** quando for o caso.
5. Acompanhe na tela o total do dia, o saldo da semana e do mês (`+HH:MM` / `-HH:MM`).
6. Exporte relatórios em **PDF** ou **Excel** (diário, semanal ou mensal) direto do app.

## Como criar o token do GitHub

O app grava os dados no seu repositório usando a API do GitHub, então precisa de um **Personal Access Token (PAT)**. Escolha um dos dois tipos:

### Opção A — Token fine-grained (recomendado)

1. No GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: algo como `ponto-app`.
3. **Expiration**: escolha um prazo (ex.: 90 dias) e anote para renovar.
4. **Repository access**: selecione **Only select repositories** e marque **apenas** este repositório do ponto.
5. **Permissions → Repository permissions**: em **Contents**, selecione **Read and write**. Nada mais é necessário.
6. Gere e **copie o token** (ele só aparece uma vez).

### Opção B — Token classic

1. No GitHub: **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**.
2. Marque os escopos **`repo`** e **`workflow`**.
3. Defina uma expiração, gere e copie o token.

> O escopo `workflow` no token classic só é necessário se você for editar/criar arquivos de workflow (`.github/workflows/`) através do app ou da API. Para o uso normal do ponto, `repo` basta.

## Como configurar o app

1. Abra o app e vá em **Configurações**.
2. Preencha:
   - **Owner**: seu usuário do GitHub (ex.: `maria-silva`);
   - **Repo**: `clockin-data` (o repositório privado onde ficam os registros);
   - **Token**: o PAT criado acima.
3. Salve. A configuração fica no `localStorage` do navegador (chave `ponto.config`) — só nesse aparelho/navegador. Se usar em mais de um aparelho, configure em cada um.
4. **Modo demonstração**: ative a opção "demo" (ou simplesmente não informe token) para testar o app sem rede — tudo fica salvo apenas no `localStorage` do navegador.
5. Com token configurado, o app também mantém um cache local (`ponto.cache.AAAA-MM`) como reserva offline: se a rede falhar, a batida não se perde e é sincronizada depois.

## Estrutura dos dados

Um arquivo JSON por mês, no caminho `registros/AAAA-MM.json`:

```json
{
  "dias": {
    "2026-07-22": {
      "batidas": ["08:01", "12:02", "13:00", "17:05"],
      "obs": "",
      "tipo": "normal"
    }
  }
}
```

- `batidas`: horários `"HH:MM"` (24h) em ordem crescente; pares consecutivos são períodos trabalhados.
- `obs`: observação livre do dia.
- `tipo`: `"normal"` | `"feriado"` | `"ferias"` | `"atestado"` | `"abono"`. Qualquer tipo diferente de `normal` zera a meta do dia.
- Datas sempre no formato ISO `AAAA-MM-DD`, no fuso America/Sao_Paulo.

Como é tudo texto simples num repositório Git, você tem **histórico completo** de cada alteração (cada batida vira um commit) e pode editar os arquivos manualmente se precisar.

## Relatório mensal automático

Uma GitHub Action (`.github/workflows/relatorio-mensal.yml`) roda **todo dia 1º por volta das 00:30 (horário de Brasília)** e gera o relatório do **mês anterior**:

- `relatorios/AAAA-MM.md` — tabela por dia (batidas, trabalhado, meta, saldo), totais do mês e a lista de **dias úteis sem registro** e de **dias inconsistentes** (batida sem par);
- `relatorios/AAAA-MM.csv` — mesmo conteúdo em CSV com separador `;`, BOM UTF-8 e decimais com vírgula, pronto para abrir no Excel brasileiro com dois cliques.

Os arquivos são commitados no repositório pelo `github-actions[bot]` — nenhum token seu é usado; a Action usa o `GITHUB_TOKEN` temporário do próprio GitHub.

**Rodar manualmente**: na aba **Actions** do repositório, escolha *Relatório mensal de ponto* → **Run workflow**. Opcionalmente informe o campo `mes` (formato `AAAA-MM`) para regenerar o relatório de qualquer mês; vazio gera o do mês anterior.

**Rodar no seu computador** (requer Node 20+):

```bash
node scripts/gerar-relatorio.js           # mês anterior
node scripts/gerar-relatorio.js 2026-06   # mês específico
```

Se não existir `registros/AAAA-MM.json` para o mês, o script encerra sem gerar nada (e sem erro).

## Segurança do token — leia com atenção

- **O token dá acesso de escrita ao seu repositório.** Quem tiver o token pode ler e alterar seus dados (e, no caso do token classic com `repo`, TODOS os seus repositórios). Trate-o como uma senha.
- **Prefira o token fine-grained** restrito a apenas este repositório e apenas à permissão *Contents: Read and write*. É o menor privilégio possível.
- **Nunca commite o token** em nenhum arquivo do repositório. Ele deve existir apenas no `localStorage` do seu navegador.
- **Repositório privado**: recomendamos manter este repositório **privado** — seus horários de trabalho são dados pessoais. Atenção: o GitHub Pages em repositório privado exige plano pago (GitHub Pro); alternativa gratuita é manter o repositório de dados separado, ou aceitar o repositório público sabendo que os registros ficam visíveis.
- **Defina expiração** no token e renove periodicamente. Se suspeitar de vazamento, revogue imediatamente em *Settings → Developer settings → Personal access tokens*.
- **Não use o app em computador compartilhado** sem depois limpar os dados do site (o token fica no `localStorage`).
- O GitHub tem *secret scanning*: se um token vazar num commit público, ele costuma ser revogado automaticamente — mas não conte só com isso.

## Estrutura do projeto

```
index.html                              app (uma página, CSS inline, CDNs de jsPDF/SheetJS)
js/storage.js                           persistência (GitHub Contents API + localStorage)
js/reports.js                           cálculos puros + exportação PDF/Excel
js/app.js                               interface
registros/AAAA-MM.json                  dados de ponto (um arquivo por mês)
relatorios/AAAA-MM.{md,csv}             relatórios mensais gerados pela Action
scripts/gerar-relatorio.js              gerador do relatório (Node, sem dependências)
.github/workflows/relatorio-mensal.yml  agendamento mensal
```
