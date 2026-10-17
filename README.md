# Galactic Atlas — protótipo

Atlas 3D navegável da Via Láctea: uma galáxia procedural determinística para a escala global
e **822 mil estrelas reais** (Gaia DR3 + Hipparcos/HYG) com posições derivadas de astrometria,
carregadas sob demanda a partir de uma octree binária compacta (20 bytes/estrela), com filtros por tipo espectral, luminosidade, magnitude absoluta e cor.

Consumo medido (Chrome): ~2 MB de dados estelares residentes na visão galáctica, ~9 MB perto do
Sol com ~40 nós carregados; GPU = o mesmo + 6 MB da galáxia procedural; heap JS ≈ 40 MB.

Base para uma futura ferramenta de worldbuilding espacial — nesta versão, somente atlas e navegação.

## Executar

Requisitos: Node ≥ 22.6 (usa `--experimental-strip-types` para rodar TypeScript no pipeline e nos testes).

```bash
npm install
npm run data        # baixa HYG + Gaia DR3 (~15 min, depende da carga do Gaia Archive) e gera o catálogo
npm run dev         # http://localhost:5173
```

Sem rede? `npm run data:sample` gera um catálogo mínimo a partir de um recorte **real** do HYG
(`pipeline/sample/hyg-sample.csv`, ~350 estrelas: < 8 pc e as mais brilhantes). A UI o marca como exemplo.

Outros comandos: `npm test` (transformações, formato, octree), `npm run build` (typecheck + bundle de produção em `dist/`).

## Controles

| entrada | ação |
|---|---|
| arrastar | orbitar em torno do foco |
| botão direito / shift + arrastar | deslocar o foco |
| roda | zoom logarítmico (0,4 AU → 250 kpc) |
| W A S D · R F (shift ×5) | voar; velocidade proporcional à escala |
| clique / duplo clique | selecionar / selecionar e centralizar |
| C · Z · Esc | centralizar / aproximar / limpar seleção |
| H · G | Sol / galáxia inteira |
| T | painel de filtros (classe espectral, luminosidade, M_G/M_V, BP−RP; Alt+clique isola um chip) |
| M | gerenciar o mundo ativo (etiquetas, campos, estrelas anotadas, mundos, exportar/importar) |

A vista, as camadas e a exposição são salvas em `localStorage` e restauradas ao reabrir.

## Seu mundo

Selecione uma estrela e use **Anotar estrela** no painel: nome no seu universo, descrição,
etiquetas e campos que você define (texto, número com unidade, escolha única ou múltipla,
sim/não). Estrelas anotadas ganham um anel e o nome do universo no mapa e aparecem primeiro
na busca. Dá para ter vários mundos e exportar ou importar cada um como `.atlas-world.json`.
Tudo fica no navegador (IndexedDB), separado do catálogo científico. Detalhes em
[docs/MUNDO.md](docs/MUNDO.md).

## Arquitetura

```
pipeline/                   Node, offline — nunca roda no navegador
  fetch-gaia.ts             ADQL por faixas de G, divide faixas truncadas
  fetch-hyg.ts
  build-catalog.ts          mescla → galactocêntrico → octree por luminosidade → binários
src/core/                   compartilhado (sem Three.js)
  coords.ts                 ICRS ↔ galáctico ↔ galactocêntrico ↔ render (float64)
  format.ts                 layout binário, flags, persistentId
  photometry.ts             cor (BP−RP / B−V → T → RGB), empacotamento de magnitude
src/catalog/CatalogStore.ts índice + cache LRU de nós com orçamento de bytes; sem Three.js
src/render/
  StarLayer.ts              1 THREE.Points por nó; LOD; picking em float64; estrela focada exata
  GalaxyLayer.ts            pontos procedurais (gerados em Web Worker) + brilho do disco em shader
  galaxyModel.ts            modelo procedural determinístico (TS + GLSL)
  Overlays.ts               grades e rótulos HTML
src/nav/CameraController.ts órbita/voo com estado em float64, origem flutuante
src/world/                  dados autorais: modelo + validação/migração (puro), IndexedDB, serviço
src/render/WorldLayer.ts    marcadores das estrelas anotadas (posição exata, relativa à câmera)
src/ui/                     painel, busca, filtros, editor/gerenciador do mundo, CSS
src/main.ts                 composição e loop
```

**Decisões principais**

- **Sem React.** A UI tem poucos elementos e atualizações pontuais; DOM direto evita uma
  dependência e re-renderizações no loop de 60 fps. Dependências de runtime: apenas `three`.
- **Origem flutuante total.** A câmera da GPU fica em (0,0,0); tudo é posicionado como
  `mundo − câmera` em float64 antes de virar float32. Ver [docs/COORDENADAS.md](docs/COORDENADAS.md).
- **Octree ordenada por luminosidade (LOD físico).** Um nó só é pedido se sua estrela mais
  brilhante puder ser vista do ponto mais próximo da caixa (magnitude aparente < limite) e se
  estiver no frustum. Filhos são sempre mais fracos que o pai, então a travessia para cedo.
- **20 bytes por estrela residente**, numa única `ArrayBuffer` por nó, passada à GPU sem cópia.
- **Filtros na GPU.** Classe, luminosidade e cor ficam em 4 bytes por estrela; o filtro é um
  conjunto de uniforms no shader (instantâneo, sem recarregar dados), espelhado na CPU para
  clique, rótulos e contagens. Ver [docs/DADOS.md](docs/DADOS.md#classes-espectrais-e-filtros).
  A cópia na CPU é mantida (uma só) para picking; os pontos procedurais liberam a cópia CPU após o upload.
- **Metadados sob demanda.** Nomes, IDs e astrometria completa ficam em arquivos separados e só
  são baixados ao buscar/selecionar.
- **Cache com orçamento.** `CatalogStore` mantém um LRU de 40 MB de payload de nós (espelhado
  1:1 na GPU ⇒ ≤ 80 MB + 6 MB procedurais, dentro do orçamento de 100 MB); nós fora de vista
  são descarregados após ~10 s, ou imediatamente sob pressão.
- **Separação real × procedural × usuário.** Códigos de fonte em `format.ts` (`GaiaDR3`,
  `Hipparcos`, `Procedural`, `User` reservado). Pontos procedurais não são selecionáveis e usam
  outra cor de legenda. Dados autorais futuros devem referenciar `persistentId` e ficar fora do catálogo.

Detalhes de dados, seleção e limitações: [docs/DADOS.md](docs/DADOS.md).

Ideias e design para a evolução (worldbuilding, territórios, rotas…): [docs/IDEIAS.md](docs/IDEIAS.md).
