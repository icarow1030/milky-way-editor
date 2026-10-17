# Ideias para a evolução do atlas (worldbuilding)

Documento de design, **não implementado**. Reúne as decisões e propostas discutidas para
transformar o atlas galáctico numa ferramenta de worldbuilding de ficção científica, com o
atlas como visão macro. Nada aqui altera o catálogo científico (`public/data/catalog`), que
continua somente leitura.

Sumário:
1. [Princípio: três origens de dados](#1-princípio-três-origens-de-dados)
2. [Documento do mundo](#2-documento-do-mundo)
3. [Estrelas do usuário e como criá-las](#3-estrelas-do-usuário-e-como-criá-las)
4. [Ficha astrofísica e habitabilidade](#4-ficha-astrofísica-e-habitabilidade)
5. [Editor 2D de sistemas](#5-editor-2d-de-sistemas)
6. [Planetas, estações e entidades](#6-planetas-estações-e-entidades)
7. [Novos tipos de objeto](#7-novos-tipos-de-objeto)
8. [Facções e territórios](#8-facções-e-territórios)
9. [Régua](#9-régua)
10. [Rotas automáticas](#10-rotas-automáticas)
11. [Céu da Terra e constelações](#11-céu-da-terra-e-constelações)
12. [Ampliar o catálogo observacional](#12-ampliar-o-catálogo-observacional)
13. [Fora do escopo](#13-fora-do-escopo)
14. [Ordem sugerida](#14-ordem-sugerida)

---

## 1. Princípio: três origens de dados

Todo objeto do atlas (estrela, planeta, nebulosa…) tem uma origem explícita, visível na UI:

| Origem | Exemplo | Regra |
|---|---|---|
| **Observado** | Gaia DR3, Hipparcos, NASA Exoplanet Archive | nunca editado; só anotado ou sobrescrito por cima |
| **Procedural / sugerido** | estrelas candidatas, sistema sugerido pelo gerador | determinístico (semente), descartável; vira autoral ao ser editado |
| **Autoral** | estrelas, planetas, facções do usuário | vive no documento do mundo |

Os códigos já existem em `src/core/format.ts` (`GaiaDR3`, `Hipparcos`, `Procedural`, `User`).

## 2. Documento do mundo

Um arquivo de projeto (no espírito do `.map` do Azgaar), separado do catálogo:

```
World
├── settings     regras do universo (alcance de salto FTL, velocidades, calendário…)
├── tags         etiquetas definidas pelo usuário (classes de planeta etc.)
├── stars        estrelas fictícias, materializadas e sobrescritas
├── systems      sistema → âncora (persistentId de estrela real ou do usuário)
│   └── bodies   estrela(s) → planetas → luas / estações / construções
├── factions     civilizações, governos, instituições
├── territories  fontes de influência, células pintadas, exceções (por época)
├── routes       rotas manuais e calculadas
└── events       cronologia, referenciando qualquer entidade
```

- **Persistência:** IndexedDB para o trabalho local, mais exportação e importação de JSON.
  `localStorage` é pequeno demais.
- **Referências** sempre por id estável: `gaia-dr3:<id>`, `hip:<n>`, `hyg:<id>` para objetos
  observados; `user:<uuid>` para os autorais; `proc:v<versão>:<setor>:<n>` para procedurais.
  Nunca pelo índice interno do catálogo (`index`), que muda a cada rebuild.
- **Sobrescritas de estrelas reais** ("no meu universo, Vega tem uma companheira"): um registro
  ligado ao `persistentId`, com campos que se sobrepõem. A UI mostra o valor observado e o autoral.

## 3. Estrelas do usuário e como criá-las

Os pontos procedurais atuais **não são editados**: cada um representa milhares de estrelas
agregadas e depende da semente e da versão do modelo da galáxia.

### Estrelas candidatas sob demanda (alvos de clique)
Problema: para criar uma estrela num lugar sem catálogo, é preciso algo para clicar.

1. Na visão galáctica, clicar na névoa procedural **leva a câmera até o setor**.
2. Perto o bastante, um gerador determinístico (semente = coordenada do setor) cria algumas
   centenas de **estrelas candidatas** individuais, com densidade e tipo espectral coerentes com a
   região (mais estrelas azuis jovens nos braços, populações velhas no bojo).
3. Candidatas são desenhadas como "não reivindicadas" (mais apagadas ou com anel vazado).
4. Clicou → o painel mostra tipo e posição → **"Criar sistema aqui"** → a estrela é copiada para o
   mundo como `user:<uuid>` (copy-on-write) e deixa de depender do gerador.
5. Ao revisitar o setor, as candidatas são recriadas iguais, exceto as já reivindicadas.

As candidatas só aparecem **fora da cobertura do catálogo real**. Perto do Sol, cria-se a
partir de estrelas reais ou com o cursor 3D.

### Complementos
- **Cursor 3D (estilo Blender):** um clique no vazio projeta o ponto num plano (o plano galáctico,
  ou um plano pelo foco atual); a altura é ajustada arrastando ou com a roda.
- **"Criar perto desta":** a partir de qualquer estrela ("a ~5 ly de Sirius"), para companheiras e aglomerados.

### Renderização
Estrelas do usuário são poucas (no máximo alguns milhares): uma camada `THREE.Points` pequena,
sempre carregada, com o mesmo shader e formato de 20 bytes, com marcador próprio, incluída no picking.

## 4. Ficha astrofísica e habitabilidade

Ao criar o sistema de uma estrela (real ou autoral), mostrar **restrições realistas com
procedência**, nunca um veredito único de "habitável".

### Entradas
- Já disponíveis: magnitude, cor, distância → magnitude absoluta, luminosidade aproximada, T_eff;
  tipo espectral (HYG).
- Passo extra no pipeline: `gaiadr3.astrophysical_parameters` (T_eff, log g, [M/H], raio,
  luminosidade; massa e idade via FLAME), numa consulta em lote gravada nos metadados.
- Estrelas autorais: tipo espectral (ou massa e idade) escolhidos; o resto é derivado.

### Derivações

| Característica | Método |
|---|---|
| Zona habitável | Kopparapu et al. (2013/2014), a partir de L e T_eff |
| Linha de neve | ≈ 2,7 AU × √L |
| Tempo de vida | ≈ 10 Gyr × M^−2,5 |
| Fase evolutiva | posição no diagrama HR (M_abs × cor, ou log g) |
| Riscos estelares | anã M: travamento de maré na ZH e erupções; O/B/A: UV intenso, vida curta |
| Ocorrência de planetas | metalicidade (correlação gigante–metalicidade), taxas do Kepler |
| Multiplicidade | RUWE, tabelas de binárias do Gaia, companheiras no HYG; estabilidade (Holman & Wiegert 1999) |
| Ambiente galáctico | zona habitável galáctica (~7–9 kpc), O/B próximas (risco de supernova), associação jovem |

Cada valor exibe a origem ("observado Gaia", "derivado", "estimativa estatística") e avisos.

### Sistema sugerido
Um gerador **propõe** um sistema inicial a partir das restrições: número e tipos de planetas
pelas taxas de ocorrência, gigantes além da linha de neve, rochosos dentro dela. A semente é o
`persistentId` (a sugestão é sempre a mesma). O usuário aceita, edita ou descarta.

Planetas também têm três origens: **observados** (NASA Exoplanet Archive; ex.: TRAPPIST-1 com
seus 7 planetas), **sugeridos** e **autorais**.

## 5. Editor 2D de sistemas

- **Entrada:** duplo clique ou "Entrar no sistema" no painel. O atlas pausa a renderização e
  guarda o estado da câmera; ao voltar, a vista é a mesma.
- **Renderização em SVG** (não WebGL): poucas dezenas de objetos, com eventos de mouse, arrasto,
  seleção e texto nítido de graça.
- **Visual estilo Stellaris:** estrela (ou par binário) no centro, órbitas concêntricas
  esquemáticas, planetas como círculos com luas, estações como ícones. Sem física.
- **Edição:** clicar abre o formulário no painel lateral; arrastar muda a órbita; botões para
  adicionar e remover corpos.
- **No atlas:** marcadores nas estrelas que já têm sistema definido.

## 6. Planetas, estações e entidades

Modelo uniforme: **entidade = tipo + campos**. Pontos de atenção:

- **Derivado × autoral:** temperatura de equilíbrio, posição na ZH e período orbital são
  calculados; população, governo e descrição são autorais. Um valor derivado pode ser
  **sobrescrito** ("terraformado, agora 15 °C") sem perder o calculado.
- **Campos fixos + customizados**, com **modelos por tipo** (planeta, lua, estação, cidade…).
- **Referências, não texto:** "controlado pela Facção X" é um link para a entidade. Renomear
  atualiza tudo; apagar avisa onde é usada. Links em descrições livres (`[[Facção X]]`) tornam
  o mundo navegável como uma wiki.
- **Valores no tempo:** população, dono e nome podem ter valores por época, ligados à cronologia.
- **Ids estáveis** (`user:<uuid>`) para todo corpo, estação e construção.
- **Busca global por campos** ("planetas da Facção X com população > 1 bilhão").

### Estações e classes
- **Estação espacial:** um tipo de entidade com órbita (estrela, planeta ou ponto do sistema),
  dono, descrição e campos.
- **Classes de planeta** ("minerador", "militar", "agrícola"…): **etiquetas multisseleção
  definidas pelo usuário** (nome, cor, ícone), sem nada fixo no código.
- As etiquetas alimentam modos de mapa (ex.: "Economia" tinge sistemas pela classe dominante) e
  filtros ("só sistemas militares da Facção X").

## 7. Novos tipos de objeto

"Estrela" passa a ser "Objeto astronômico", com um campo de **tipo** nos metadados (o formato de
renderização (20 bytes) não muda; o tipo vai nos metadados ou num atributo pequeno separado).

### Pontuais (camada de pontos, marcador por tipo)
| Tipo | Fonte |
|---|---|
| Anãs brancas | já no Gaia; classificação pelo diagrama HR / Gentile Fusillo et al. (2021) |
| Estrelas de nêutrons / pulsares | ATNF Pulsar Catalogue (~3500); distâncias por dispersão, **muito incertas** |
| Buracos negros | lista curada: Sgr A*, Gaia BH1/BH2/BH3, binárias X (BlackCAT; ex.: Cygnus X-1) |
| Anãs marrons | parte já no Gaia (< 100 pc) |

Buracos negros e estrelas de nêutrons usam **ícone**, não ponto de luz. Sem lente gravitacional.

### Extensos (camada própria: ícone de longe, forma de perto)
| Tipo | Fonte |
|---|---|
| Aglomerados abertos | Hunt & Reffert (2023), ~7000, com raio e idade |
| Aglomerados globulares | Harris / Baumgardt, ~150 |
| Regiões HII | catálogo WISE de regiões HII |
| Nebulosas planetárias | HASH |
| Remanescentes de supernova | catálogo de Green |
| Poeira 3D | Edenhofer et al. (2024); Lallement/Vergely (o mais trabalhoso e o de maior impacto visual) |

Catálogos de centenas a poucos milhares de itens: ficam inteiros em memória, selecionáveis por
esfera envolvente. Fora da cobertura, o gerador de setores também cria regiões HII e
aglomerados procedurais ao longo dos braços. Objetos autorais de qualquer tipo usam `source: User`.
A ficha astrofísica (§4) muda conforme o tipo (ex.: planetas de pulsar, como PSR B1257+12).

## 8. Facções e territórios

**Território é uma região do espaço, não uma lista de sistemas.** A pertença de um sistema é
calculada sob demanda; só os sistemas importantes (capital, colônias) são explícitos.

### Definição (combinação, com prioridade exceção > pintura > influência)
1. **Influência (estilo Stellaris), a base:** sistemas marcados como fontes, com força. Cada ponto
   pertence à facção de campo mais forte (acima de um mínimo): é um diagrama de Voronoi ponderado
   em 3D. As fronteiras surgem sozinhas, há zonas disputadas onde os campos empatam, e expandir é
   colonizar.
2. **Pintura (estilo Azgaar):** pincel esférico numa grade esparsa (células de ~25–50 pc) para
   corredores, fronteiras retas ou vazios intencionais.
3. **Exceções por sistema:** enclaves e sistemas independentes (lista curta).

O mesmo mecanismo serve para setores e províncias dentro de uma facção. Os territórios podem
ter **versões por época**, ligadas à cronologia.

### Visualização
O disco tem ~30 kpc de diâmetro e ~0,6 kpc de espessura: na escala galáctica, território é quase 2D.

- **Macro: mapa político sobre o disco.** O campo é calculado num Web Worker e vira uma textura 2D
  no plano galáctico (cores translúcidas por facção, fronteiras no shader do disco, nome no
  centro). É um modo de mapa ("Político") que se liga e desliga.
- **Local: dentro do volume.**
  1. **Estrelas tingidas** pela cor do dono: o shader consulta uma textura 3D do território pela
     posição da estrela, **sem nenhum byte extra por estrela**. Opção principal.
  2. **Plano de corte** na altura da câmera (seção transversal).
  3. **Superfície de fronteira** translúcida (opcional; confusa quando se está dentro).
  4. **Rede de rotas** da facção.

### Contagens
- Onde há catálogo: contagem exata de estrelas catalogadas no volume (que não são todas as estrelas reais).
- Fora: estimativa pela densidade do modelo da galáxia integrada no volume, mais as taxas da
  ficha astrofísica para "sistemas com ZH plausível".
- A UI separa **contado** de **estimado**.

### Custo
Por facção: lista de fontes + células pintadas + exceções = kilobytes. Texturas do campo são
recalculadas no Worker a cada edição e nunca salvas.

## 9. Régua

- Dois cliques (estrela real, autoral, candidata ou ponto do cursor 3D) → linha e distância em
  pc / ly / AU, renderizada relativa à câmera.
- **Vários pontos:** soma de trechos (rota manual).
- **Tempo de viagem** quando o mundo define velocidades fictícias (ex.: "classe 2 = 40 ly/dia").

## 10. Rotas automáticas

Busca de caminho (A* / Dijkstra) num grafo, em que **o tipo de rota é a função de custo**.

### Grafo
- **Nós:** sistemas (reais, autorais, candidatos).
- **Arestas:** saltos até o **alcance máximo de FTL**, regra do mundo em `settings` (e se o FTL
  exige partir de uma estrela ou pode parar no vazio).
- Construído sob demanda: os vizinhos vêm da octree existente, só para os nós explorados.

### Perfis (pesos por salto)

| Fator | Expressa | Normal / segura |
|---|---|---|
| Distância / tempo | peso alto | peso médio |
| Salto máximo | longo | curto |
| Densidade estelar no salto | bônus em corredores vazios | neutro |
| Sistemas com estação / facção aliada (checkpoints) | ignora | bônus |
| Perto de estrela de nêutrons, buraco negro, nebulosa, O/B | penalidade pequena | penalidade alta ou zona proibida |
| Território hostil | penalidade média | evita |

Perigos usam campos como os territórios (raio de influência; cada salto paga pelo trecho
próximo). Perfis customizados são possíveis (ex.: "contrabandista").

### Escala
- **Busca hierárquica** (como um GPS): grade grosseira de setores (~100 pc, custos agregados)
  para escolher o corredor, depois refino estrela a estrela dentro dele.
- **Hiperrotas manuais** funcionam como rodovias de custo baixo que as rotas automáticas aproveitam.
- Tudo num Web Worker.

### Resultado
- Linha 3D com marcadores de salto, colorida por risco.
- Itinerário: saltos, distância, tempo, risco, territórios atravessados, paradas.
- Comparação lado a lado (expressa × segura).
- Pode ser salva como entidade **Rota**, referenciável por eventos, facções e comércio.
- Paradas em estrelas candidatas (regiões sem catálogo) são marcadas como fictícias.

## 11. Céu da Terra e constelações

Camada de curiosidade (mais visual do que útil para o worldbuilding).

- **Vista "Céu da Terra":** a câmera vai à posição do Sol (a Terra fica a 1 AU, irrelevante
  nessa escala; a câmera já chega a ~0,4 AU com precisão). O modo muda de órbita para **olhar ao
  redor** (girar a cabeça) e a magnitude-limite passa a ~6,5, a de olho nu. Movimento próprio e
  paralaxe anual são ignoráveis.
- **Linhas de constelação:** traçados abertos e bem usados (ex.: o do Stellarium), definidos por
  números HIP, que já estão no catálogo. O traçado não é oficial da IAU.
- **Fronteiras oficiais da IAU** (88 constelações; Delporte, 1930): permitem dizer a constelação
  de *qualquer* estrela, inclusive estrelas Gaia sem nome.
- **Filtro por constelação** no painel de filtros ("só estrelas de Órion").
- **Efeito 3D:** ao se afastar da Terra com as linhas ligadas, as figuras se desmontam (Betelgeuse a
  ~150 pc, Rigel a ~260 pc, o cinturão mais longe), mostrando que constelações só existem daquele
  ponto de vista.
- **Ligação com o worldbuilding:** o céu visto de um sistema do usuário é outro; dá para criar
  **constelações fictícias** vistas de um planeta autoral, para a cultura daquele povo.

## 12. Ampliar o catálogo observacional

Manter a qualidade atual (erro de paralaxe < 10%), mas remover os cortes de magnitude e de
volume que limitam o catálogo a ~0,8 milhão de estrelas.

Contagens no Gaia DR3 (consultadas no Gaia Archive em 2026-10-17):

| Critério `parallax_over_error` | Erro típico na distância | Estrelas |
|---|---|---|
| > 10 (qualidade atual, sem cortes) | < 10% | **98,3 milhões** |
| > 5 | até ~20% | 192 milhões |
| > 3 | até ~33% | 320 milhões |
| > 1 | até ~100% (distância ≈ prior) | 764 milhões |
| qualquer paralaxe | — | ~1,47 bilhão (de 1,81 bilhão de fontes) |

- **Prioridade:** o degrau poe > 10 sem cortes (≈ 98 M). Mesma confiabilidade de hoje, cobrindo bem
  mais longe. Uma etapa intermediária possível: poe > 10 sem corte de magnitude até 1–2 kpc.
- **Opcional, desligado por padrão:** um degrau de "posição inferida" (poe > 5 ou menos), marcado
  como tal, com a distância exibida como intervalo (Bailer-Jones). Com paralaxe ruim, a distância
  reflete sobretudo o prior do modelo galáctico, e essas estrelas formam "raios" na linha de
  visada se desenhadas como pontos exatos.
- **Volume:** a 20 bytes/estrela, 98 M ≈ 2 GB em disco (320 M ≈ 6,4 GB). A octree já carrega só o
  que está à vista; o orçamento de 100 MB comporta ~5 M de estrelas residentes. Metadados (64 B/estrela)
  pesam mais que o payload e podem ser compactados ou divididos.
- **Aquisição:** consultas TAP anônimas (60 s / 50 mil linhas) levariam dias. O caminho é baixar os
  arquivos em lote do Gaia (CDN `cdn.gea.esac.esa.int`, `gaia_source` em CSV/ECSV por HEALPix) e mais
  `external.gaiaedr3_distance`, filtrando localmente. O pipeline de build precisaria ser em
  streaming (não cabe tudo em memória) e construir a octree em disco.

## 13. Fora do escopo

- **Unidades e frotas militares:** a escala e a dinâmica de simulação fogem da proposta de atlas.
  O aspecto militar fica restrito a estações e etiquetas (ex.: classe "militar").
- Simulação gravitacional, física orbital e efeitos cinematográficos.

## 14. Ordem sugerida

1. Documento do mundo + anotações sobre estrelas reais, editáveis no painel.
2. Estrelas autorais + camada de renderização e picking.
3. Estrelas candidatas sob demanda + cursor 3D.
4. Régua.
5. Editor 2D de sistemas + entidades (planetas, luas, estações, etiquetas).
6. Ficha astrofísica (incluindo `astrophysical_parameters` do Gaia e exoplanetas da NASA).
7. Facções e territórios (influência → mapa político → estrelas tingidas).
8. Novos tipos de objeto (anãs brancas, aglomerados, pulsares, buracos negros, nebulosas, poeira 3D).
9. Rotas automáticas com perfis.
10. Céu da Terra e constelações; ampliação do catálogo (poe > 10 sem cortes) quando houver necessidade de mais cobertura.
