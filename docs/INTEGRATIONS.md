# Intégrations : ce qui est vérifié, ce qui est documenté

Un client est « **vérifié** » lorsqu'un test automatisé s'est connecté à ce serveur (Streamable HTTP, en-tête
`Authorization: Bearer awp_…`), a listé les 13 outils et a appelé `get_account` avec succès. « **Documenté** » : la
documentation officielle de la plateforme décrit une configuration compatible, mais nous ne l'avons pas exécutée.
« **Non compatible / à confirmer** » : la plateforme exige OAuth ou ne permet pas d'en-tête statique.

Les tests ont été exécutés le 2026-10-20 contre une instance locale de ce serveur branchée sur le vrai backend AIWorkPay
(environnement isolé, Stripe simulé). Ils n'ont **pas** été exécutés contre `https://mcp.aiworkpay.fr` (inaccessible depuis
l'environnement de test) : utilisez `npm run smoke:remote` pour le déploiement.

## Vérifié par un test exécuté

| Client | Version | Résultat | Configuration |
| --- | --- | --- | --- |
| SDK Python MCP officiel (`mcp`) | 2.3.0 | 13 outils, `get_account` OK | `create_mcp_http_client(headers=…)` + `streamable_http_client` |
| OpenAI Agents SDK | 0.24.0 | 13 outils, `get_account` OK | `MCPServerStreamableHttp(params={"url", "headers"})` |
| LangChain / LangGraph (`langchain-mcp-adapters`) | 0.3.2 / langgraph 1.2.16 | 13 outils, `get_account` OK | `MultiServerMCPClient({… "transport": "streamable_http", "headers"})` |
| CrewAI (`crewai-tools[mcp]`) | 1.15.28 | 13 outils, `get_account` OK | `MCPServerAdapter({"url", "transport": "streamable-http", "headers"})` |
| AutoGen (`autogen-ext[mcp]`) | 0.7.5 (avec `mcp<2`) | 13 outils, `get_account` OK | `StreamableHttpServerParams(url, headers)` |
| Client MCP du SDK TypeScript | 1.32.1 | scénario complet (10 tests), HTTP et stdio | `test/e2e/` |

AutoGen a révélé un défaut réel, corrigé en 0.7.0 : les schémas d'entrée de `prepare_workforce_handoff` contenaient des `$ref`
(JSON Schema valide) qu'AutoGen ne sait pas résoudre. Les schémas sont désormais autonomes (`test/contract.test.ts`).
Note : `autogen-ext` 0.7.5 est incompatible avec `mcp` 2.x (import cassé) ; installez `mcp<2` avec lui.

Scripts de vérification : `scripts/compat/` (une quinzaine de lignes par framework).

## Documenté, non exécuté

| Plateforme | Ce que dit la documentation | Réserve |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http aiworkpay https://mcp.aiworkpay.fr/mcp --header "Authorization: Bearer $AIWORKPAY_API_KEY"` | non exécuté ici |
| Claude Desktop | connecteurs distants via l'interface ; en-têtes statiques seulement en bêta pour certaines organisations | à confirmer par compte ; sinon passer par `stdio` (voir README) |
| Mistral (connecteurs MCP), Grok (API), Perplexity | MCP distant avec en-têtes d'autorisation | non exécuté ici |

## Non compatible en l'état

| Plateforme | Raison |
| --- | --- |
| ChatGPT (applications / connecteurs) | authentification OAuth ou aucune ; pas d'en-tête `Bearer` statique confirmé |
| Annuaire des connecteurs Claude | OAuth 2.0 requis |

Lever ces deux limites suppose d'ajouter OAuth 2.0 (flux autorisation + enregistrement dynamique de client) au serveur, avec un écran
où un humain autorise l'agent et choisit ses plafonds. C'est un chantier à part, qui touche à l'authentification des agents.
