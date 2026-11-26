### 1.3 Integridade entre cela e área

Decisão funcional confirmada: **não pode existir interno cadastrado em uma área sem cela definida**. Portanto:
- `localizacoes.cela_id` será NOT NULL;
- `celas`: UNIQUE (`id`, `area_id`);
- `localizacoes`: FK composta (`cela_id`, `area_id`) → `celas(id, area_id)`.

Isso impede localização sem cela e impede que uma cela de outra área seja vinculada incorretamente. Linhas de PDF sem cela válida devem ficar em staging como divergência, sem criar cadastro ativo até correção humana.