# Mundo (dados autorais)

Tudo o que você cria vive num **mundo**, guardado à parte do catálogo científico
(`public/data/catalog`, que nunca é escrito pelo app). Fase 1: anotações sobre estrelas reais.

Código: [`src/world/`](../src/world) (modelo, persistência, serviço),
[`src/render/WorldLayer.ts`](../src/render/WorldLayer.ts) (marcadores),
[`src/ui/worldEditor.ts`](../src/ui/worldEditor.ts), [`worldManager.ts`](../src/ui/worldManager.ts),
[`worldUi.ts`](../src/ui/worldUi.ts). Testes: [`tests/world.test.ts`](../tests/world.test.ts).

## Uso

| Onde | O quê |
|---|---|
| Barra de ferramentas › nome do mundo | trocar de mundo, criar, gerenciar, exportar, importar |
| Painel da estrela › **No seu mundo** | “Anotar estrela”; nome no universo, descrição, etiquetas, campos; salva sozinho |
| **Gerenciar mundo** (tecla **M**) | abas Mundo (nome, descrição, resumo, armazenamento, exportar/importar), Estrelas (lista, filtro, órfãs), Etiquetas, Campos, Mundos |
| Camada **Mundo** | anéis nas estrelas anotadas (cor da 1ª etiqueta) e nomes do universo; ligar/desligar na barra |
| Busca | nomes do universo e etiquetas (primeiro), `source_id` do Gaia (`Gaia DR3 123…` ou só o número), designações do catálogo |

Ações destrutivas (apagar etiqueta, campo, opção, mundo, anotação) pedem um segundo clique e dizem
quantas estrelas são afetadas.

## Modelo

```
WorldMeta  id ("world:<uuid>"), name, description, schemaVersion, createdAt, updatedAt,
           tags: TagDef[]      { id ("t:…"), name, color }
           fields: FieldDef[]  { id ("f:…"), label, type, options, unit, kinds }
Entity     id ("user:<uuid>"), worldId, kind ("star"), anchor, name, description,
           tags: TagDef ids, fields: { FieldDef id → valor }, createdAt, updatedAt, rev
StarAnchor ids[] (todos os identificadores da estrela: gaia-dr3:…, hip:…, hyg:…),
           catalogBuild, index, ra, dec, dist (instantâneo), label
```

- **Tipos de campo:** texto curto, texto longo, número (com unidade), escolha única, múltipla
  escolha e sim/não. Valores são validados contra o tipo (`coerceValue`). Mudar o tipo converte os
  valores, avisando quantos se perdem; renomear uma opção atualiza os valores que a usam; apagar
  campo, opção ou etiqueta remove-os das estrelas.
- **Campos são indexados pelo id**, não pelo rótulo: renomear um campo não quebra nada.
- **Uma estrela = no máximo uma anotação por mundo.** Mundos são independentes, e a mesma estrela
  pode ter dados diferentes em cada um.

## Ligação com o catálogo

O índice de uma estrela muda quando o catálogo é reconstruído. Por isso a âncora guarda:

1. **todos os identificadores** da estrela (Gaia, HIP, HYG);
2. o `buildId` do catálogo em que o índice vale. O `buildId` é um hash da ordem das estrelas:
   reconstruir com os mesmos dados dá o mesmo `buildId`.

Ao abrir um mundo, âncoras de outro `buildId` são **religadas** pelo mapa `ids/<shard>.json`, que
o pipeline gera (todos os identificadores → índice, em 256 arquivos de ~130 KB baixados sob
demanda). Se nenhum identificador existir mais, a anotação vira **órfã**: continua salva, aparece
marcada na lista e no mapa (pela posição guardada), e volta a funcionar se a estrela voltar ao
catálogo. Testado de fato: catálogo de exemplo → completo → âncoras religadas corretamente.

## Persistência

- **IndexedDB** (`galactic-atlas`: lojas `worlds` e `entities`, chave `[worldId, id]`). Gravações
  agrupadas a cada ~350 ms e ao esconder/fechar a página; falhas são reexecutadas e avisadas.
- Na primeira anotação o app pede `navigator.storage.persist()` para o navegador não apagar os
  dados por falta de espaço. Sem IndexedDB (alguns modos privados), o app funciona só em memória
  e avisa.
- Várias abas: as mudanças salvas numa aba são recarregadas nas outras (`BroadcastChannel`), se
  estas não tiverem edições pendentes.
- O mundo ativo é lembrado entre sessões.

## Arquivo de mundo (exportar/importar)

`<nome>.atlas-world.json`, legível e versionável no git:

```json
{ "format": "galactic-atlas-world", "formatVersion": 1, "exportedAt": "…",
  "catalogBuild": "96b01243-822496", "world": { … }, "entities": [ … ] }
```

A importação valida tudo (`parseWorldFile`): rejeita arquivos de outro tipo ou de versão mais nova,
descarta valores, etiquetas e campos inválidos, e aplica migrações quando o formato evoluir
(`MIGRATIONS` em `model.ts`). Se já existir um mundo com o mesmo id: **substituir** ou
**importar como cópia** (novos ids).

## Limites desta fase

- Só estrelas reais podem ser anotadas; estrelas fictícias vêm na fase 2 (mesmo modelo, sem âncora).
- Não há desfazer/refazer: a remoção pede confirmação, e exportar funciona como backup.
- Os dados ficam no navegador em que foram criados; para levar a outro computador, exporte e importe.
