# OpenCode Auto Model Switcher

Plugin nativo para OpenCode **1.19.5** que escolhe automaticamente o melhor modelo
disponivel, monitora o uso de contexto, troca de modelo sem perder historico e trata
erros de provedor (429, quota, overload, indisponibilidade, TLS/rede).

Compatibilidade comprovada contra as definicoes de tipo e o servidor reais instalados
nesta maquina (`@opencode-ai/plugin@1.19.5`, `@opencode-ai/sdk@1.19.5`). Nenhum hook,
evento, propriedade ou metodo foi inventado.

## Arquivos

- `~/.config/opencode/plugins/auto-model-switcher.ts` - plugin (auto-descoberto, nenhuma
  alteracao no `opencode.json` e necessaria).
- `~/.config/opencode/auto-model-switcher.json` - estado/config do plugin (criado
  automaticamente; pode ser editado ou gerenciado pelas ferramentas).

## Instalacao

1. O arquivo do plugin ja esta em `~/.config/opencode/plugins/`, que o OpenCode 1.19.5
   descobre automaticamente.
2. Saia e reabra o OpenCode (a config e carregada uma vez na inicializacao).
3. Verifique com `/models-status` ou pedindo ao assistente para usar a ferramenta
   `model_switcher_status`.

Nao e necessario editar `opencode.json`. Se quiser configurar explicitamente
(versao 1.19.5 usa a chave singular `plugin`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugins/auto-model-switcher.ts"]
}
```

## Como funciona

- Ordem inicial de prioridade: os 20 modelos do briefing, do mais promissor ao menos
  promissor. Todos existem e suportam tool call na API real deste ambiente.
- O modelo principal e sempre o primeiro da lista habilitado e disponivel.
- Em `chat.message`, o plugin define `output.message.model` (propriedade real de
  `UserMessage` na API 1.19.5) antes da requisicao sair. Isso troca o modelo do turno
  **dentro da mesma sessao**, preservando todo o historico (nada e apagado nem
  reiniciado).
- Uso de contexto: le os tokens reais do ultimo `AssistantMessage` via
  `session.messages`. Usa `tokens.total` (que a API entrega como
  `input + output + reasoning + cache.read + cache.write`) ou o mesmo somatorio.
  Compara com `model.limit.context`. Nao confunde tokens de saida com contexto total.
- Ao atingir o limite (padrao 90%), a proxima mensagem passa para um modelo cuja janela
  de contexto seja maior que a atual e comporte os tokens ja usados. Prefere uma janela
  que mantenha o uso abaixo do limite configurado; se nenhum modelo tiver janela maior,
  permanece no modelo atual (nao troca para um modelo menor nem fica ciclando na fila).
- Fallback: o hook `event` escuta `session.error`, classifica o erro e marca cooldown do
  modelo/provedor, avanca a fila e (opcionalmente) tenta continuar automaticamente sem
  repetir trabalho ja concluido.
- Sessao nova comeca no modelo principal. Sessao existente continua de onde estava
  (deriva a posicao do ultimo modelo usado).

## Interface

Comandos (injetados pelo hook `config`, confirmados em `/command`):

- `/models-status` - modelo atual, provedor, % de contexto, proximo modelo, disponiveis.
- `/models-list` - lista os 20 modelos com prioridade, estado e disponibilidade real.
- `/models-next` - avanca manualmente para o proximo modelo.
- `/models-reset` - restaura a ordem inicial de prioridade.

Ferramentas (chamaveis pelo assistente):

- `model_switcher_status`
- `model_switcher_list`
- `model_switcher_switch` (`mode=next|prev`, `index=1..20`, ou `model=provider/model`)
- `model_switcher_reorder` (`from`, `to`)
- `model_switcher_toggle` (`scope=plugin|model`, `index`, `enabled`)
- `model_switcher_threshold` (`percent` 1..100)
- `model_switcher_history` (`limit`)
- `model_switcher_reset` (`scope=order|history|all`)

Estado (`auto-model-switcher.json`):

```jsonc
{
  "enabled": true,
  "thresholdPct": 0.9,
  "autoRetry": true,
  "maxAutoRetries": 2,
  "requireToolcall": true,
  "order": [ { "providerID": "...", "modelID": "...", "enabled": true } ],
  "history": []
}
```

## Resultados dos testes (executados nesta maquina, OpenCode 1.19.5)

Testes end-to-end reais (servidor `opencode serve` real, provedores reais):

| # | Teste | Metodo | Resultado |
|---|-------|--------|-----------|
| 1 | Carregamento do plugin | servidor real, sem erros no log | OK |
| 2 | Registro de tools/comandos | `GET /experimental/tool/ids` e `/command` | 8 tools + 4 comandos |
| 3 | Novo modelo usuario vs. `chat.message` | sessao nova via API | usuario e assistente = `opencode/deepseek-v4.1-flash-free` (posicao 1) |
| 4 | Troca ao passar do limite de contexto | limite ~0, 2 turnos | turno 1 `nvidia/deepseek-v4.1-flash`, turno 2 `nvidia/stepfun-ai/step-5-preview` |
| 5 | Fallback por erro do provedor | erro TLS real do provedor `opencode` | avancou para `nvidia` e concluiu |
| 6 | Auto-retry apos erro | 1 erro -> retry sintetico | retry executado, sessao continuou |
| 7 | Troca entre OpenCode e NVIDIA | sessoes reais | `opencode` -> `nvidia` |
| 8 | Preservacao do historico | contagem de mensagens antes/depois | 2 -> 4 -> 6, sem perda |
| 9 | Continuidade da mesma sessao | mesma sessionID | OK |
| 10 | Nova sessao no modelo principal | nova sessionID | posicao 1 |
| 11 | Ferramenta chamada pelo assistente (e2e) | pedido real ao agente | `model_switcher_list` status `completed` |
| 12 | Todos indisponiveis | harness com todos desabilitados | sem override, toast + log de erro, `0/20` disponiveis |

Testes deterministas (harness importando o plugin com os dados reais de `providers`):

- `model_switcher_status`, `list`, `switch` (index e next), `reorder`, `toggle`,
  `threshold`, `history`, `reset` - todos OK.
- Plugin desativado -> `chat.message` nao altera o modelo (confirmado `null`).

Dados reais usados nos testes:

- 20/20 modelos do briefing existem; todos com `capabilities.toolcall = true`,
  status `active`, nos provedores `opencode` e `nvidia`.
- Exemplo real de tokens: `total=138174`, `input=3426`, `output=310`,
  `reasoning=22`, `cache.read=134416`, `cache.write=0`.

## Limitacoes conhecidas

- O indice de sessao e mantido em memoria. Ao reiniciar o OpenCode, sessoes existentes
  re-derivam a posicao do ultimo modelo realmente usado no historico (nada se perde; a
  posicao avancada por erro pode voltar ao ultimo modelo persistido).
- O percentual de contexto e estimado a partir do ultimo `AssistantMessage.tokens`
  (dado real), que e o melhor proxy disponivel pela API para o tamanho do prompt atual.
- Erros 429/quota/overload nao puderam ser provocados artificialmente neste ambiente;
  o classificador os trata por `statusCode` e por padroes de mensagem, alem de
  `isRetryable`, `ProviderAuthError` e erros de rede/TLS. O caso real reproduzido foi
  TLS/indisponibilidade do provedor `opencode` (`certificate is not yet valid`), tratado
  como provider-down.
- O auto-retry envia uma mensagem sintetica de continuacao; e limitado por
  `maxAutoRetries` para nunca entrar em loop. Pode ser desligado (`autoRetry: false` ou
  ferramenta de toggle).
- A chamada automatica de ferramentas depende do modelo conseguir emitir tool calls;
  verificado com `nvidia/deepseek-ai/deepseek-v4.1-flash`. Os modelos NVIDIA deste
  ambiente sao lentos (~2 min/turno), o que afetou o tempo dos testes.
- A documentacao online do OpenCode reflete uma versao mais nova (chave `plugins`,
  plugins de GUI). Este plugin usa a superficie real de 1.19.5 (`plugin` /
  auto-descoberta e os hooks presentes em `@opencode-ai/plugin@1.19.5`).

## Seguranca

- Nao le, escreve nem exibe chaves de API. Nao acessa `auth.json`.
- Escreve apenas o proprio `auto-model-switcher.json`.
- Nao apaga arquivos do usuario nem altera projetos abertos.
- Logs via `client.app.log` (servico `auto-model-switcher`) e toasts para diagnostico.
- Nunca cria nova sessao durante a troca; historico sempre preservado.
