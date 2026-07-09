# Monitor Operacional Iter FIDC — Proposta de Arquitetura

> **Status:** proposta de arquitetura (etapa de design — sem código de produção).
> **Objetivo:** app desktop leve, aberto 100% do horário de trabalho, consolidando o status
> de todas as rotinas operacionais (Estoque, Carteira Diária, Cessões, Monitoramento AKRK,
> Relatório DI, Acompanhamento de Lastros, Saldo Devedor — e dezenas futuras).

---

## 1. Pesquisa de mercado e escolha da stack

### 1.1 O que a pesquisa mostrou (jul/2026)

Números consolidados de comparativos recentes (fontes ao final do documento):

| Framework | Instalador | RAM em idle* | Backend Python | UI HTML/CSS/JS | Curva p/ time Python | Maturidade |
|---|---|---|---|---|---|---|
| **Electron** | 80–200 MB | ~200 MB (Chromium embutido) | via subprocess/ZeroRPC (gambiarra) | Sim | Média (exige Node) | Muito alta |
| **Tauri 2** | 2–10 MB | ~30 MB (núcleo) + WebView2 do SO | Sidecar, `tauri-plugin-python` ou **PyTauri** | Sim | Alta (Rust no core; PyTauri mitiga) | Alta e crescendo |
| **Neutralino.js** | 1–5 MB | ~20 MB + WebView do SO | Via "extensions" (processo separado, WebSocket) | Sim | Média | Média/baixa |
| **PySide6/Qt Widgets** | 40–100 MB | 50–90 MB | Nativo (é Python) | Não nativamente (só via QWebEngine = Chromium embutido) | Baixa p/ lógica, alta p/ UI Qt | Muito alta |
| **pywebview** | ~10–60 MB (PyInstaller, depende das deps) | Python ~30–50 MB + WebView2 do SO | **Nativo (é Python)** | Sim | **Muito baixa** | Alta (projeto de 2014, estável) |

\* No Windows, qualquer opção baseada em WebView (Tauri, Neutralino, pywebview) usa o **WebView2/Edge
que já está instalado e é compartilhado pelo SO** — o custo de RAM do WebView (~60–100 MB) é
praticamente o mesmo entre elas. O diferencial real de memória entre esses três é pequeno;
o diferencial de **manutenção** é enorme.

Consenso dos desenvolvedores em 2026 (blogs técnicos, discussões públicas e X):
- **Tauri virou a recomendação padrão** para apps desktop novos quando leveza importa
  ("Electron democratizou o desktop; Tauri está democratizando o desktop performático" — Fireship).
- **Electron** continua o mais maduro, mas é sistematicamente descartado quando o requisito é
  "ficar aberto o dia todo sem pesar": ~200 MB de RAM em idle só do runtime.
- **Neutralino** é elogiado para utilitários muito simples, mas o ecossistema é pequeno e a
  integração com Python é a mais frágil das três (processo externo via WebSocket, pouca documentação).
- **PyTauri** (binding Python p/ Tauri via PyO3, com wheels pré-compiladas desde a v0.4 que
  dispensam o compilador Rust) gerou bastante interesse em 2025/2026, mas ainda é jovem —
  comunidade pequena, breaking changes frequentes.
- **pywebview** aparece consistentemente como "o Electron minúsculo do mundo Python":
  binário pequeno, startup < 500 ms, usa o WebView nativo do SO, e o backend **é** Python puro.

### 1.2 Recomendação: **pywebview** (com rota de migração para Tauri)

**Recomendo pywebview para este projeto.** Justificativa pelos trade-offs que importam aqui:

1. **O time é Python-first.** Todo o stack existente (scripts de ingestão, n8n chamando Python,
   BigQuery client, validações) é Python. Com pywebview, o app desktop é *um pacote Python* —
   qualquer pessoa do time que mantém os scripts de hoje consegue manter o app. Com Tauri puro,
   alguém precisa aprender Rust; com PyTauri, você depende de um projeto jovem; com Electron,
   você adiciona um segundo ecossistema (Node) só para a casca.
2. **A leveza real no Windows vem do WebView2 compartilhado, não do framework.** Tauri, Neutralino
   e pywebview usam o mesmo WebView2 do sistema. A diferença de RAM em idle entre "núcleo Rust de
   5 MB" e "processo Python de 40 MB" é irrelevante para um desktop corporativo moderno — e ambos
   ficam **muito** abaixo dos ~200 MB do Electron.
3. **Instalador não é gargalo aqui.** O app roda em 1–3 máquinas internas, não é distribuído a
   clientes. Um instalador de 40 MB (PyInstaller) vs. 5 MB (Tauri) não muda nada na prática.
   (Cuidado apontado pela comunidade: PyInstaller embute dependências desnecessárias se o
   ambiente estiver poluído — usar venv limpo dedicado ao build.)
4. **UI em HTML/CSS/JS puro** — exatamente o que precisamos para reaproveitar no modo leve
   compartilhável (item 4 do escopo). A mesma pasta `ui/` alimenta os dois modos.
5. **Rota de saída barata.** A arquitetura proposta abaixo isola a "casca" (janela) do "core"
   (Python + HTML). Se um dia pywebview não bastar (ex.: precisar de auto-updater sofisticado,
   distribuição externa), a migração para **Tauri + sidecar Python** troca só a casca: o core
   Python e a UI HTML são 100% reaproveitados. Essa é a decisão de menor arrependimento.

**Quando eu reavaliaria:** se o app for distribuído para fora da gestora (instalador polido,
auto-update, assinatura de código) → Tauri; se a UI precisar de gráficos nativos pesadíssimos
com milhões de pontos → PySide6/QtCharts. Nenhum dos dois é o cenário atual.

---

## 2. Arquitetura geral

Princípio central: **o app desktop não executa as rotinas — ele as observa.** Quem executa
continua sendo n8n + scripts Python (e, no futuro, o próprio scheduler do app pode assumir
algumas). O app lê *estado* de fontes diversas, consolida num cache local, e renderiza.
Isso é o que garante leveza: a UI nunca fala com BigQuery diretamente; ela lê SQLite local.

```
┌─────────────────────────── FONTES DE DADOS ───────────────────────────┐
│  BigQuery          JSON (n8n/scripts)      Planilhas         Futuras  │
│  (API oficial)     (cache/log em disco)    (Excel/CSV do     (REST de │
│                                            SharePoint/Drive)  ADMs)   │
└──────┬──────────────────┬───────────────────────┬───────────────┬─────┘
       │                  │                       │               │
       ▼                  ▼                       ▼               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   CAMADA DE CONECTORES (datasources/)                   │
│   Interface DataSource: check_access() · fetch() · metadata()          │
│   BigQuerySource │ JsonSource │ SpreadsheetSource │ RestApiSource(+)    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        CORE / ORQUESTRAÇÃO (core/)                      │
│  • Registry de rotinas (descobre pastas em routines/)                  │
│  • Scheduler leve (asyncio): cada rotina tem seu intervalo de polling  │
│  • Modelo de status hierárquico (rotina mãe → subtarefas)              │
│  • Avaliador de regras (atrasado? divergente? fonte inacessível?)      │
└───────┬──────────────────────────────────────┬─────────────────────────┘
        │                                      │
        ▼                                      ▼
┌──────────────────────────┐      ┌────────────────────────────────────┐
│  ARMAZENAMENTO LOCAL     │      │      CANAIS DE ALERTA (channels/)  │
│  (storage/)              │      │  Interface AlertChannel            │
│  • SQLite: estado atual  │      │  TelegramChannel (compatível com   │
│    + histórico de runs   │      │    o bot atual) │ WhatsApp (futuro)│
│  • CSV por rotina:       │      │  Dedup/rate-limit centralizado     │
│    data_ref_ADM vs       │      └────────────────────────────────────┘
│    data_ingestao_BQ      │
│    (→ Grafana futuro)    │
└─────┬──────────────┬─────┘
      │              │
      ▼              ▼
┌───────────────┐  ┌──────────────────────────────────────┐
│ UI DESKTOP    │  │ EXPORT HTML LEVE (export/)           │
│ (pywebview)   │  │ Arquivo estático único (HTML+CSS+JS  │
│ HTML/CSS/JS   │  │ inline), gerado a cada N min pelo    │
│ rico: drill-  │  │ próprio app → salvo no SharePoint /  │
│ down, logs,   │  │ enviado por link. Zero instalação    │
│ histórico,    │  │ para quem recebe.                    │
│ gráficos      │  └──────────────────────────────────────┘
└───────────────┘
```

### Fluxo típico (rotina Estoque, exemplo)

1. Scheduler acorda o coletor da rotina `estoque` no intervalo configurado (ex.: 15 min).
2. Passo obrigatório 0 — **verificação de acesso**: cada `DataSource` da rotina responde
   `check_access()` (Drive alcançável? credencial BQ válida? pasta SharePoint acessível?).
   Falha aqui gera alerta imediato ("opere manualmente") sem nem tentar o fetch.
3. Coleta: `JsonSource` lê o log que o n8n/script gravou; `BigQuerySource` roda a query de
   controle (contagem/última partição do dataset `EstoquesGeral`).
4. Regras avaliam: arquivo do dia chegou? ingestão bateu com o esperado? média móvel de 30 dias
   dentro da banda?
5. Resultado grava em SQLite (estado) + CSV (trilha p/ Grafana). Mudança de status ruim → alerta
   Telegram. UI desktop e export HTML apenas *leem* o SQLite.

---

## 3. Padrão de conectores (item 2 do escopo)

Interface única, implementações plugáveis — a UI e as regras nunca sabem de onde o dado veio:

```python
# datasources/base.py (esboço ilustrativo)
class DataSource(ABC):
    """Toda fonte implementa o mesmo contrato."""

    @abstractmethod
    def check_access(self) -> AccessResult:
        """Checagem proativa e barata: a fonte está alcançável/autenticada?
        NUNCA levanta exceção — retorna ok/erro + mensagem p/ alerta."""

    @abstractmethod
    def fetch(self, query: SourceQuery) -> SourceResult:
        """Busca os dados. Sempre com timeout e retorno normalizado."""

    def metadata(self) -> dict:
        """Última atualização, latência, custo estimado — p/ exibir na UI."""
```

Implementações iniciais:

| Classe | Fonte | Observações |
|---|---|---|
| `BigQuerySource` | `google-cloud-bigquery` | Só queries de *controle* (metadados, contagens, MAX(data)); nunca dados brutos volumosos. Cache obrigatório. |
| `JsonSource` | Arquivos JSON locais/rede | Camada intermediária barata: n8n/scripts gravam JSON, o app só lê disco. **Fonte preferencial** — quase custo zero. |
| `SpreadsheetSource` | Excel/CSV (SharePoint/Drive sincronizados localmente) | Leitura via `openpyxl`/`pandas` sob demanda; nunca carrega a planilha inteira se só precisa do cabeçalho/última linha. |
| `RestApiSource` (futuro) | APIs de administradoras | Mesma interface; só criar a classe e referenciar no YAML da rotina. |

As rotinas **referenciam fontes por nome no YAML** (ver §4) — trocar a fonte de uma rotina é
editar uma linha de config, não código de exibição.

---

## 4. Estrutura extensível por rotina (item 3 — o núcleo)

Cada rotina = **uma pasta autocontida** em `routines/`, descoberta automaticamente pelo
registry na inicialização. Adicionar a rotina "Cessões" = duplicar uma pasta modelo e editar
o YAML. Zero mudança no core.

### Manifesto de rotina (`routine.yaml`)

```yaml
# routines/estoque/routine.yaml (esboço)
id: estoque
nome: "Atualização de Estoque"
responsavel: "@fernando"
schedule: "*/15 8-19 * * 1-5"        # polling do MONITOR (não da execução)
clickup:
  list_id: "..."                      # vínculo conceitual — ver §4.2
canais_alerta: [telegram]

# Requisito obrigatório: toda rotina declara sua checagem de acesso
verificacao_acesso:
  - fonte: gdrive_hemera              # Drive da Hemera alcançável?
  - fonte: bq_estoques                # credencial/dataset BQ ok?
  - fonte: sharepoint_estoques

subtarefas:                           # hierarquia mãe → filhas
  - id: download_drive
    nome: "Download da pasta Google Drive (Hemera)"
    fonte: json_n8n_estoque           # n8n grava JSON de status
    regras: [arquivo_do_dia_presente, nomenclatura_valida]
  - id: upload_sharepoint
    nome: "Upload SharePoint (retenção 5 dias; histórico p/ Cred.Estruturado e B33)"
    fonte: json_n8n_estoque
  - id: ingestao_bigquery
    nome: "Ingestão BigQuery (EstoquesGeral)"
    fonte: bq_estoques
    regras: [particao_do_dia_existe, contagem_dentro_banda]
  - id: validacoes
    nome: "Validações (consistência, baixas, média móvel 30d)"
    fonte: json_validacoes_estoque
    regras: [todas_validacoes_ok]

log_csv:
  campos_extra: [data_ref_adm, data_ingestao_bq]   # trilha p/ Grafana
```

Cada subtarefa tem **status, fonte e log próprios**; a rotina mãe agrega (pior status filho
propaga para cima). Regras genéricas (`arquivo_do_dia_presente`, `contagem_dentro_banda`)
vivem no core e são parametrizadas; regras muito específicas podem ser um `checks.py` opcional
dentro da pasta da rotina (o registry importa se existir).

### 4.1 Estrutura de pastas do projeto

```
00.Monitor_Desktop/
├── ARQUITETURA.md            # este documento
├── pyproject.toml
├── app/                       # CASCA desktop (trocável: pywebview hoje, Tauri amanhã)
│   ├── main.py                # bootstrap da janela + tray icon + start do core
│   └── bridge.py              # ponte JS↔Python (API exposta à UI)
├── core/
│   ├── registry.py            # descobre e valida pastas de routines/
│   ├── scheduler.py           # asyncio: um "tick" por rotina, intervalos independentes
│   ├── models.py              # Rotina, Subtarefa, Status, Run, Alerta
│   ├── rules.py               # regras genéricas parametrizáveis
│   └── state.py               # leitura/escrita SQLite
├── datasources/
│   ├── base.py                # interface DataSource
│   ├── bigquery.py
│   ├── jsonfile.py
│   ├── spreadsheet.py
│   └── sources.yaml           # catálogo nomeado de fontes (credencial, path, projeto BQ…)
├── channels/
│   ├── base.py                # interface AlertChannel
│   ├── telegram.py            # reusa o bot/token atual
│   └── whatsapp.py            # (futuro — mesma interface)
├── routines/
│   ├── _template/             # pasta modelo — duplicar p/ criar rotina nova
│   │   └── routine.yaml
│   ├── estoque/
│   │   ├── routine.yaml
│   │   └── checks.py          # validações específicas (opcional)
│   ├── carteira_diaria/
│   │   └── routine.yaml
│   ├── cessoes/               # …uma pasta por rotina, até dezenas
│   ├── akrk/
│   ├── relatorio_di/
│   ├── lastros/
│   └── saldo_devedor/
├── ui/                        # frontend HTML/CSS/JS (SEM framework pesado; vanilla ou Preact)
│   ├── index.html             # modo desktop rico
│   ├── components/
│   └── shared/                # peças reutilizadas pelo export leve
├── export/
│   ├── generator.py           # renderiza status.html estático a cada N min
│   └── template_lite.html     # versão leve compartilhável
└── storage/                   # gerado em runtime (gitignored)
    ├── monitor.db             # SQLite: estado + histórico
    └── logs/
        └── estoque_2026-07.csv
```

### 4.2 Integração conceitual com ClickUp

Sem criar nada lá ainda — o desenho:

- Cada `routine.yaml` pode declarar `clickup.list_id` / `clickup.task_id`.
- Um `ClickUpChannel` (mesma interface dos canais de alerta) sincroniza **status → ClickUp**:
  rotina atrasada abre/atualiza uma task; subtarefas do YAML mapeiam para subtasks do ClickUp.
- Direção única no início (app → ClickUp) para evitar conflito de fonte de verdade; o estado
  canônico é o SQLite do monitor.
- Como ClickUp tem MCP/API rica, isso é um módulo isolado — não toca o core.

### 4.3 Verificação de acesso como cidadã de primeira classe

Todo tick de rotina começa pelo bloco `verificacao_acesso` do YAML. Falha de acesso é um
status próprio (`ACESSO_INDISPONIVEL`, distinto de `ATRASADO` ou `ERRO`), com alerta
direcionado ao responsável — exatamente o cenário "avisar para operar manualmente enquanto
a automação não está pronta". Para fontes sem automação ainda (ex.: MCC Iron por e-mail),
a rotina pode ser declarada `modo: manual` — a subtarefa vira um checklist que alguém marca
na própria UI, mas já aparece no painel consolidado desde o dia 1.

---

## 5. Dois modos de visualização (item 4)

**Mesma base, dois renderizadores:**

- **Desktop rico:** pywebview abre `ui/index.html`; o JS chama a ponte Python (`bridge.py`)
  que lê o SQLite. Drill-down por subtarefa, histórico de runs, logs, gráficos (uPlot ou
  Chart.js — leves). Fica na bandeja do sistema quando minimizado.
- **HTML leve compartilhável:** `export/generator.py` roda dentro do próprio app (job do
  scheduler, ex.: a cada 10 min) e gera **um único arquivo estático** `status.html` com tudo
  inline (status atual, últimos alertas, carimbo de hora). Destino: pasta do SharePoint já
  sincronizada → qualquer pessoa abre pelo link, sem instalar nada. Se um dia quiser algo
  "vivo", o mesmo gerador pode ser servido por um `http.server` mínimo — mas o export
  estático cobre o caso de uso com custo zero.

Nada é implementado duas vezes: a lógica de status vive no core; os dois modos são
apresentações do mesmo SQLite, e `ui/shared/` guarda CSS/componentes comuns.

---

## 6. Leveza como requisito de projeto (item 5)

Decisões que garantem o "aberto o dia todo sem incomodar":

1. **UI nunca consulta fonte externa.** Só lê SQLite local (<1 ms). Todo custo de rede fica
   no scheduler, em background, com intervalos por rotina.
2. **BigQuery com parcimônia:** só queries de metadados/contagem, resultados cacheados em
   SQLite com TTL; intervalo padrão 15–30 min, configurável por rotina; janela de operação
   no cron do YAML (ex.: só 8h–19h em dias úteis — à noite o app fica 100% ocioso).
3. **JSON como fonte preferencial:** onde o n8n já executa a rotina, ele grava um JSON de
   status — o app só lê disco. Custo praticamente nulo.
4. **asyncio, não threads por rotina:** dezenas de rotinas = dezenas de corrotinas adormecidas,
   não dezenas de threads. CPU ~0% entre ticks.
5. **Sem framework JS pesado:** vanilla JS ou Preact (~4 KB). Sem React+bundle de 300 KB
   rodando no WebView o dia inteiro.
6. **Tray icon + janela única:** minimizar esconde a janela; o WebView2 suspende renderização
   de janela oculta, derrubando o consumo.
7. Orçamento-alvo (verificável no piloto): **< 120 MB RAM total em idle** (Python + WebView2),
   **CPU ≈ 0%** fora dos ticks, **startup < 2 s**.

---

## 7. Alertas e logs (item 6)

- **`AlertChannel`** espelha o padrão `DataSource`: `send(alerta)` + `check_access()`.
  `TelegramChannel` usa o bot/token atuais; WhatsApp futuro = nova classe + uma linha no YAML.
- **Dedup e escalonamento no core** (não no canal): mesma falha não re-alerta a cada tick;
  re-alerta em escalada (15 min → 1 h → 4 h) enquanto não resolver.
- **CSV por rotina/mês** em `storage/logs/`, com no mínimo: `timestamp`, `rotina`, `subtarefa`,
  `status`, `data_ref_adm`, `data_ingestao_bq`, `mensagem`. Esse é exatamente o dataset do
  futuro dashboard Grafana (ADM × BigQuery); opcionalmente o mesmo log sobe para uma tabela
  BQ de telemetria, deixando o Grafana plug-and-play depois.

---

## 8. Próximos passos práticos (item 7)

**Fase 0 — Esqueleto (1–2 dias)**
1. Criar o esqueleto de pastas acima com `pyproject.toml` (deps: `pywebview`, `pyyaml`,
   `google-cloud-bigquery`, `pandas`/`openpyxl`, `aiosqlite`).
2. Implementar `core/registry.py` + `core/models.py` + `datasources/base.py` + `JsonSource`
   (a fonte mais simples primeiro).
3. Janela pywebview abrindo um `index.html` "olá, rotinas registradas: N" + tray icon.

**Fase 1 — Piloto Estoque (a rotina já mapeada)**
4. Escrever `routines/estoque/routine.yaml` completo (subtarefas do fluxo Drive → SharePoint
   → BQ → validações), com `verificacao_acesso` para Drive, SharePoint e BQ.
5. Ajustar os scripts/n8n existentes do Estoque para **gravarem o JSON de status** ao final
   de cada etapa (mudança pequena e não invasiva no que já roda hoje).
6. Implementar `BigQuerySource` (checagem de partição/contagem no `EstoquesGeral`) e o
   `TelegramChannel` reaproveitando o bot atual.
7. UI desktop v1: lista de rotinas → drill-down de subtarefas → log. Medir RAM/CPU em idle
   contra o orçamento do §6.

**Fase 2 — Piloto Carteira Diária + export leve**
8. Duplicar `_template/` para `carteira_diaria/` — este é o teste real de extensibilidade:
   se precisar tocar no core, a arquitetura falhou e ajustamos antes de escalar.
9. Implementar `export/generator.py` + `template_lite.html` gravando no SharePoint.
10. Rodar as duas rotinas por ~2 semanas; só então cadastrar as demais (Cessões, AKRK,
    Relatório DI, Lastros, Saldo Devedor) em ritmo de "uma pasta nova por rotina".

**Fase 3 — Integrações**
11. `ClickUpChannel` (status → tasks), tabela BQ de telemetria p/ Grafana, e avaliação de
    WhatsApp como segundo canal.

---

## Fontes da pesquisa (consultadas em 09/07/2026)

- [Tauri vs Electron vs Neutralino 2026 — bundles, memória (PkgPulse)](https://www.pkgpulse.com/guides/tauri-vs-electron-vs-neutralino-desktop-apps-javascript-2026)
- [Best Desktop App Frameworks 2026 (PkgPulse)](https://www.pkgpulse.com/guides/best-desktop-app-frameworks-2026)
- [Tauri vs Electron vs Neutralinojs 2026 — comparativo prático (Pikvue)](https://pikvue.com/tauri-vs-electron-vs-neutralinojs-2026-best-desktop-app-framework-compared/)
- [Tauri vs Electron 2026 — guia completo](https://blog.nishikanta.in/tauri-vs-electron-the-complete-developers-guide-2026)
- [Tauri in 2026 (DEV Community)](https://dev.to/ottoaria/tauri-in-2026-build-cross-platform-desktop-apps-with-web-technologies-better-than-electron-11mo)
- [PyTauri (GitHub)](https://github.com/pytauri/pytauri) · [PyTauri — debate na comunidade (BigGo)](https://biggo.com/news/202510140726_PyTauri_Python_Tauri_Binding)
- [tauri-plugin-python (GitHub)](https://github.com/marcomq/tauri-plugin-python)
- [pywebview — site oficial](https://pywebview.flowrl.com/) · [pywebview como alternativa minúscula ao Electron (2025)](https://johal.in/pywebview-python-tiny-electron-cef-alternative-cross-platform-2025/)
- [pywebview + PyInstaller — tamanho do executável (issue #353)](https://github.com/r0x0r/pywebview/issues/353)
- [PySide6 — tray/menu bar apps (PythonGUIs)](https://www.pythonguis.com/tutorials/pyside6-system-tray-mac-menu-bar-applications/)
