# Sistemas de coordenadas

Toda a matemática lógica é feita em **float64** (números JS). A GPU só recebe vetores
**relativos à câmera** em float32. Implementação: [`src/core/coords.ts`](../src/core/coords.ts);
validação: [`tests/coords.test.ts`](../tests/coords.test.ts).

## Unidades

- Distâncias: **parsec (pc)** em todo o código. Conversões na UI: 1 pc = 3,261 563 8 ly = 206 264,8 AU.
- Ângulos: graus nas APIs públicas; radianos internamente.

## Referenciais

| Referencial | Origem | Eixos | Uso |
|---|---|---|---|
| **ICRS equatorial** | Sol | (α, δ, d) | entrada dos catálogos |
| **Equatorial cartesiano heliocêntrico** | Sol | +x → (α=0, δ=0); +z → polo norte celeste | intermediário |
| **Galáctico cartesiano heliocêntrico** | Sol | +X → centro galáctico (l=0, b=0); +Y → l=90° (sentido da rotação); +Z → polo norte galáctico | l, b exibidos |
| **Galactocêntrico (MUNDO)** | Sgr A* | convenção astropy v4.0: +x do Sol para o CG; +y → l=90°; +z → PNG | posições lógicas, octree, câmera |
| **Render** | câmera | eixos do mundo | o que vai para a GPU |

### ICRS → Galáctico

Matriz de rotação do Hipparcos (ESA 1997, Vol. 1, §1.5.3), que define o sistema galáctico
no ICRS. Validado contra o SIMBAD (Sirius, Vega, Betelgeuse, Polaris, Sgr A*, α Cen):
erro < 0,002°.

### ICRS → Galactocêntrico

Mesma construção do `astropy.coordinates.Galactocentric` (padrões v4.0):

```
x_gc = H · (R · x_icrs − d · x̂)
R = Rx(η) · Ry(−δ_CG) · Rz(α_CG)        (rotações passivas)
H = Ry(−θ),  θ = asin(z☉ / d)
```

| Parâmetro | Valor | Fonte |
|---|---|---|
| α_CG, δ_CG (Sgr A*) | 266,4051°, −28,936175° | Reid & Brunthaler (2004) |
| d = R₀ (Sol–CG) | 8122 pc | GRAVITY Collaboration (2018) |
| z☉ (altura do Sol) | 20,8 pc | Bennett & Bovy (2019) |
| η (roll₀) | 58,5986320306° | astropy |

Resultado: **Sol em (−8121,97; 0; +20,8) pc**. O plano xy do mundo é o plano médio galáctico;
o plano b = 0 heliocêntrico está inclinado θ ≈ 0,147° em relação a ele.

## Precisão numérica e origem flutuante

- Em float32, uma coordenada de 8 kpc tem resolução de ~0,0005 pc (~100 AU): inutilizável para
  aproximar-se de uma estrela. Por isso **a câmera Three.js fica sempre na origem**; a posição
  real da câmera é mantida em float64 em `CameraController.position`.
- Cada nó da octree guarda posições **relativas ao seu centro** em float32. A cada quadro,
  `object.position = centro_do_nó − câmera` é calculado em float64 e só então convertido.
- A estrela selecionada é desenhada como um ponto separado na posição exata (float64, a partir
  de α, δ, d) e ocultada no seu nó (`gl_VertexID`), o que a mantém estável mesmo a ~1 AU de
  distância. Vizinhas a parsecs de distância podem ter erro de ~100 AU — invisível nessas escalas.
- Zoom limitado a [2·10⁻⁶ pc (≈0,4 AU), 2,5·10⁵ pc]. Plano near proporcional à distância de órbita.
- Sem teste de profundidade nos pontos (mistura aditiva independe de ordem), o que elimina
  problemas de precisão do z-buffer em escalas que variam 10¹¹×.
