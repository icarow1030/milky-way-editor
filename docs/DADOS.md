# Dados astronômicos e pipeline de importação

O pipeline (`pipeline/`) roda em Node, fora do navegador, e é independente do renderizador:
compartilha apenas `src/core` (matemática de coordenadas e formato binário).

```
npm run data:fetch-hyg    # HYG v4.1 (CSV, ~34 MB)            -> data-raw/hygdata_v41.csv
npm run data:fetch-gaia   # Gaia DR3 (CSV em faixas de G)      -> data-raw/gaia/*.csv
npm run data:build        # mescla, converte, particiona       -> public/data/catalog/
npm run data:sample       # alternativa offline: recorte real do HYG (pipeline/sample)
```

## Fontes

### Gaia DR3 (ESA)
Consulta ADQL ao Gaia Archive (TAP, `gea.esac.esa.int`), **uma consulta por faixa de
magnitude**, nunca uma por estrela:

```sql
SELECT g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.ruwe,
       g.phot_g_mean_mag, g.bp_rp,
       d.r_med_geo, d.r_lo_geo, d.r_hi_geo,              -- Bailer-Jones et al. (2021)
       h.original_ext_source_id AS hip                    -- cruzamento Hipparcos-2
FROM gaiadr3.gaia_source g
LEFT JOIN external.gaiaedr3_distance d ON d.source_id = g.source_id
LEFT JOIN gaiadr3.hipparcos2_best_neighbour h ON h.source_id = g.source_id
WHERE g.parallax_over_error > 10 AND (g.phot_g_mean_mag < 10 OR g.parallax > 10)
```

- **Parte A** — G < 10: estrelas brilhantes até alguns kpc (traçam a estrutura local).
- **Parte B** — paralaxe > 10 mas (≤ 100 pc), G ≥ 10: vizinhança solar, incluindo anãs M.
- `parallax_over_error > 10` limita o erro fracionário da paralaxe a < 10%.
- Distância: mediana geométrica de Bailer-Jones (2021) quando disponível; senão 1/ϖ.

Restrições do serviço anônimo, tratadas pelo script: tarefas assíncronas abortam após 60 s e
consultas síncronas são truncadas em 50 000 linhas — às vezes **silenciosamente**, cortando o
fluxo num múltiplo de 8192 linhas. O script divide faixas truncadas ao meio e reexecuta. Conferência
contra `COUNT(*)` no arquivo: parte A = 470 561 linhas (exato); volume de 100 pc = 371 766 de
372 226 — as 460 ausentes não têm `phot_g_mean_mag` (NULL), logo não têm brilho para renderizar.

### Catálogo gerado (build de 2026-10-16)

| | estrelas |
|---|---|
| Gaia DR3 (após deduplicação) | 811 480 |
| ↳ com nomes HYG via Hipparcos-2 | 92 527 |
| ↳ com nomes HYG via cruzamento posicional | 13 461 |
| Somente HYG/Hipparcos (brilhantes ou fora da seleção Gaia) | 11 016 |
| **Total** | **822 496** em 60 nós (profundidade máx. 8) |

Payload de renderização do catálogo inteiro: 16,4 MB; metadados: 52,6 MB (em disco, sob demanda).

### HYG v4.1 (Hipparcos + Yale Bright Star + Gliese)
D. Nash / astronexus, CC BY-SA 4.0. Fornece nomes próprios, designações Bayer/Flamsteed, HD, HR,
Gliese e tipo espectral, e as estrelas brilhantes que o Gaia satura ou não mede bem (G ≲ 3).

### Mesclagem
1. Estrela Gaia com vizinho Hipparcos-2 → astrometria Gaia + nomes do HYG.
2. Linhas HYG restantes → cruzamento posicional com Gaia (raio 90″, |Δd|/d < 30%, |Δmag| < 1,5).
3. Linhas HYG sem correspondente e com distância finita → mantidas com astrometria Hipparcos.
4. Linhas HYG com `dist ≥ 100000` (sem paralaxe) → descartadas: não têm posição 3D.

## Formato binário (`src/core/format.ts`)

- **Octree por luminosidade**: raiz cúbica de 16 384 pc centrada no Sol; cada nó guarda as
  16 384 estrelas **mais luminosas** da sua região que não estão em ancestrais; o restante vai
  para os 8 filhos. Filhos só contêm estrelas mais fracas que o pai — isso é o LOD.
- `nodes/<id>.bin` — **20 bytes/estrela**: posição float32×3 relativa ao centro do nó +
  RGB (uint8×3) + magnitude absoluta empacotada (uint8, passos de 0,125 mag) + props de filtro
  (classe espectral, classe de luminosidade, BP−RP em passos de 0,025, flags). É o único dado
  residente por estrela, enviado à GPU sem cópia. Formato v2 (`index.json` → `version`).
- `nodes/<id>.meta.bin` — 64 bytes/estrela (fonte, flags, HIP, source_id Gaia, α, δ em float64,
  distância e intervalo, paralaxe e erro, magnitude, cor). Baixado **só ao selecionar**;
  cache de 8 nós.
- `names.json` — designações (~110 mil linhas), baixado uma vez para busca e rótulos.
- `index.json` — nós (centro float64, meia-aresta, contagem, offset, faixa de magnitude),
  procedência e contagens.

### Identidade estável
- `index` (uint32) = offset do nó + posição: compacto, mas **muda se o catálogo for reconstruído**.
- `persistentId` (string): `gaia-dr3:<source_id>`, `hip:<n>` ou `hyg:<id>`. Dados autorais
  futuros (sistemas, civilizações, rotas…) devem referenciar o `persistentId` e viver fora de
  `public/data/catalog`, que é tratado como somente leitura.

## Classes espectrais e filtros

Implementação: [`src/core/spectral.ts`](../src/core/spectral.ts); testes: `tests/spectral.test.ts`.

- **Catalogado** quando o HYG traz o tipo (também para estrelas Gaia cruzadas com o HYG): a string
  é interpretada (`K1III`, `A0m...`, `DA2`, `sdB5`, prefixos `d`/`g`/`c`/`sd`, notação Am
  `kA2hA5mA7V`). Classe e luminosidade são tratadas separadamente: `A0m...` dá classe A
  catalogada e luminosidade estimada.
- **Estimado** nos demais casos:
  - classe: T_eff a partir de BP−RP (Mucciarelli & Bellazzini 2020) → O ≥ 30 000 K, B ≥ 10 000,
    A ≥ 7 500, F ≥ 6 000, G ≥ 5 200, K ≥ 3 700, M ≥ 2 300 K;
  - luminosidade: distância vertical a uma sequência principal aproximada do Gaia no plano
    (BP−RP, M_G). Anãs brancas: > 4,5 mag abaixo, M > 9 e BP−RP < 1,6. Subanã (VI) > 1,5 mag
    abaixo; V até 1 mag acima; IV até 2,5 acima; acima disso III, II (M < −3) ou I (M < −5);
  - **sem classe de luminosidade quando RUWE > 1,4**: com astrometria ruim (em geral binárias),
    a distância e, portanto, a posição no diagrama HR não são confiáveis.
- Para estrelas só do HYG, BP−RP é **convertido** de B−V via T_eff (flag `ColorConverted`).
- Resultado no catálogo atual: ~83% das classes são estimadas. Há 19,7 mil anãs brancas, número
  coerente com o censo de 100 pc do Gaia (~21 mil), e 179 mil estrelas sem classe de
  luminosidade (RUWE alto ou sem cor).

Os filtros (painel **Filtros**, tecla T) combinam máscaras de classe e luminosidade, a origem do
tipo (catalogado/estimado) e faixas de M (M_G para Gaia, M_V para HYG) e de BP−RP. Rodam no
shader (ocultar ou esmaecer) e são espelhados na CPU para clique, rótulos e contagens. A estrela
selecionada sempre permanece visível. O estado fica salvo com a vista.

## Limitações conhecidas

- **Seleção ≠ Galáxia.** O catálogo é limitado em magnitude (G < 10) e em volume (100 pc).
  Sua distribuição espacial reflete a seleção e a extinção por poeira, não a distribuição real
  de estrelas. Fora de ~1–3 kpc só restam estrelas muito luminosas.
- **Distâncias.** Paralaxe não é distância: mesmo com ϖ/σ > 10, 1/ϖ é enviesado; usamos
  Bailer-Jones quando disponível. Para o HYG não há erro de paralaxe; estrelas além de 200 pc
  são marcadas como incertas (σ_ϖ do Hipparcos ≈ 1 mas). Binárias não resolvidas e RUWE alto
  podem ter astrometria ruim (o RUWE é baixado mas ainda não usado como filtro).
- **Épocas.** Gaia em J2016.0, Hipparcos/HYG em J2000.0; movimentos próprios não são aplicados.
  Irrelevante para posições 3D, mas um cruzamento posicional precisa de raio generoso.
- **Fotometria.** Sem correção de extinção/avermelhamento. Cores (BP−RP → T_eff, Mucciarelli &
  Bellazzini 2020; B−V → T_eff, Ballesteros 2012) são aproximações visuais. Bandas G e V misturadas.
- **Estrelas muito brilhantes** (G ≲ 3) vêm do Hipparcos, com distâncias menos precisas.
- **Classes estimadas** não corrigem extinção: estrelas atrás de poeira parecem mais frias e
  mais fracas, podendo cair na classe ou luminosidade errada.
- **Busca** cobre nomes e designações do HYG; busca por `source_id` Gaia ainda não é suportada.
- **Galáxia procedural** (`src/render/galaxyModel.ts`) é uma ilustração determinística: 4
  braços logarítmicos (pitch 12°) cruzando o azimute do Sol em ~4,9 / 6,9 / 9,6 / 13,4 kpc,
  esporão de Órion, barra de ~4,5 kpc a ~27°, disco exponencial. Não é dado observacional.
