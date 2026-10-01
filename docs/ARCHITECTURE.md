# AIWorkPay MCP Server — Analyse de l'existant et architecture V1

> Statut : **proposition, à valider avant implémentation.**
> Analyse réalisée sur `cortexAI-2025/aiworkpay` @ `9a3ac79` (2026-09-26).

## 0. Quel backend ?

Le dépôt `aiworkpay-mcp-server` est vide. Plusieurs dépôts AIWorkPay coexistent :

| Dépôt | Stack | Verdict |
| --- | --- | --- |
| **`aiworkpay`** (privé) | Vite/React + **Supabase** (Postgres, RLS, Edge Functions Deno) + Stripe | **Cible retenue.** Le plus récent, API documentée (`public/openapi.yaml`, `public/llms.txt`), clés API hachées avec scopes, wallet agent, politique de dépense, séquestre, audit log, rate limiting. |
| `Aiworkpay-v2` | Next.js + Prisma + Stripe | Implémentation parallèle plus simple : clés API en clair, sans scopes, sans wallet ni politique de dépense. Non retenu. |
| `AIWorkPay-SDK-v1` | SDK Python | Cible une API `/tasks` (`create_task`, `approve_and_pay`) **qui n'existe pas** dans le backend actuel : obsolète. |
| `AIWorkPay-Backend-v1` | — | Dépôt vide. |

Tout ce qui suit concerne `aiworkpay`.

## 1. Architecture existante

```
Web app (React, Vite)  ──► Supabase client (anon key + RLS)
Agents / Payworkers    ──► Edge Functions  /functions/v1/{missions,payments}
                                │  auth (_shared/auth.ts) → rate limit → authorize(route, scope)
                                ▼
                       PostgreSQL : fonctions SECURITY DEFINER atomiques
                       (create_mission, validate_assignment, expire_mission…)
                                │
Stripe ──► /functions/v1/stripe-webhook (financement wallet, Connect, litiges)
```

Principe fort du backend : **les Edge Functions ne modifient jamais un solde** ;
toute transition passe par une fonction SQL transactionnelle qui revérifie
politique, propriété et rôle. Le MCP doit s'appuyer sur ce contrat, pas le dupliquer.

## 2. Endpoints disponibles (`/functions/v1`)

| Méthode | Route | Acteur | Scope |
| --- | --- | --- | --- |
| POST | `/missions` | agent | `missions:write` — **débite** `unit_price × slots` (séquestre) |
| GET | `/missions?status=&limit=&mine=` | agent / payworker | `missions:read` |
| GET | `/missions/{id}` | agent / payworker | `missions:read` |
| PUT | `/missions/{id}` | agent | `missions:write` (titre, description, priorité, skills ; prix et slots immuables) |
| GET | `/missions/{id}/assignments` | agent / payworker | `missions:read` |
| POST | `/missions/{id}/expire` | agent | `missions:write` — uniquement **après** la deadline, rembourse le non réglé |
| POST | `/missions/{id}/take` | payworker | — |
| POST | `/missions/assignments/{id}/submit` | payworker | — |
| POST | `/missions/assignments/{id}/revise` | agent | `missions:validate` — aucun mouvement d'argent |
| POST | `/missions/assignments/{id}/validate` | agent | `missions:validate` — **libère le paiement** (90/10) |
| POST | `/missions/assignments/{id}/abandon` | payworker | — |
| POST | `/payments/funding` | agent | `payments:fund` — URL Stripe Checkout, payée par un humain |
| POST | `/payments/withdrawals`, `/payments/connect/*` | payworker | — |

Conventions : montants en **centimes entiers**, devises **EUR / USD**, erreurs
`{ error: { code, message, request_id } }`, en-tête `X-Request-Id` accepté et
renvoyé, 120 req/min par agent, `429` + `Retry-After`. Pas de webhooks : polling.

## 3. Modèles

- **Mission** (`missions`) : lot de N exécutions identiques au prix unitaire
  `unit_price_cents`. Champs : `title`, `description`, `slots_total/taken/settled`,
  `deadline`, `priority`, `status ∈ {open, in_progress, completed, expired}`,
  `expertise_required`, `skills_required`, **`executor_type ∈ {payworker, agent, api, service}`**,
  `requires_human_validation`, `commission_rate`.
- **Assignment** (`mission_assignments`) : une exécution par un payworker.
  `status ∈ {in_progress, submitted, settled, abandoned}`, `submission` (texte ≤ 20 000),
  `feedback`, `attempts`, horodatages. **C'est là que vit le résultat.**
- **User** (`profiles`) : `user_type` (`ai` = mode agent, sinon payworker), expertise, abonnement.
- **Agent** = `agent_wallets` : identité économique `agent_ref` (`APA-…`), devise,
  `balance_cents`, `reserved_cents`, statut. **Un seul wallet par compte.**
- **Spending policy** : budget mensuel, limite journalière, max par opération,
  seuil de validation humaine, catégories autorisées.
- **Worker** : pas de table dédiée ; un payworker est un `profile` + `payworker_earnings`
  + compte Stripe Connect. Réputation calculée côté front (`useReputation`).

## 4. Authentification

- Agents : `X-API-Key: aiwp_…` → `verify_api_key()` (SHA-256, expiration, révocation,
  `last_used`) → `{ walletId, agentRef, scopes }`. Max 5 clés actives par compte.
- Scopes : `missions:read`, `missions:write`, `missions:validate`, `payments:fund`.
- Payworkers : `Authorization: Bearer <session Supabase>`.
- Le MCP n'a besoin **que** de la clé agent. Jamais de clé service-role ni de clé Stripe.

## 5. Paiements

Financement par carte (Stripe Checkout, crédité uniquement sur webhook signé) →
débit réel à la commande, mis en séquestre → libération par exécution validée
(90 % payworker / 10 % commission, réduite selon abonnement) → remboursement du
non-réglé à l'expiration (le travail soumis avant la deadline reste payé) →
retrait payworker via Stripe Connect. Politique de dépense appliquée
atomiquement en SQL sur le **total du lot**.

## 6. Réutilisable tel quel

- Tout le cycle de vie mission : création, lecture, liste, suivi des exécutions,
  validation / demande de révision, expiration.
- Identité par agent + scopes par clé → permissions MCP **sans rien ajouter**.
- Contrôles financiers serveur (solde, plafonds, budget, catégories), rate limiting,
  audit log, request-id : le MCP n'a pas à les réimplémenter.
- `executor_type` : déjà prévu pour router vers humain / agent / API / service.
- `openapi.yaml` : source pour générer/typer le client HTTP du MCP.

## 7. Ce qui manque (écarts)

Classés par impact sur la V1. « Backend » = à faire dans `aiworkpay`, pas dans le MCP.

| # | Écart | Impact | Proposition |
| --- | --- | --- | --- |
| G1 | **Pas d'annulation** : seul `expire` existe, et uniquement après la deadline. | `cancel_mission()` impossible proprement. | Backend : RPC `cancel_mission` qui ferme la mission et rembourse les slots non pris (les exécutions en cours/soumises restent dues). En attendant, le MCP n'expose pas `cancel_mission` ou le limite aux missions échues. |
| G2 | **Pas d'idempotence** sur `POST /missions`. Un retry réseau = double débit. | Risque financier réel. | Backend : en-tête `Idempotency-Key` + colonne unique `(agent_wallet_id, idempotency_key)`. MCP : envoie toujours la clé ; garde-fou local de déduplication en attendant. |
| G3 | **`requires_human_validation` n'est qu'un drapeau** : la mission est débitée et publiée quand même. | La « validation explicite » de la politique n'est pas appliquée. | Backend : statut `pending_approval` non visible du marketplace tant que le propriétaire n'a pas approuvé. MCP : signale clairement le cas dans la réponse. |
| G4 | **Pas de champs structurés** : ni `type`, ni `location`, ni exigences de preuve. | Le MCP doit sérialiser ces informations dans `description`. | V1 : gabarit Markdown déterministe dans `description`. Backend (V2) : colonnes `mission_type`, `location` (JSONB), `proof_requirements` (JSONB). |
| G5 | **Preuve = texte libre** (≤ 20 000 car.), pas de photos/fichiers ni de résultat structuré. | `get_mission_result()` renvoie du texte (éventuellement des URLs). | V1 : on renvoie le texte tel quel + tentative de parse JSON. Backend (V2) : Supabase Storage pour les pièces jointes + `result` JSONB validé contre un schéma fourni à la création. |
| G6 | **Devises EUR/USD uniquement.** | L'exemple Casablanca en **MAD** sera refusé. | V1 : le MCP refuse explicitement toute autre devise que celle du wallet. Le MAD est une décision produit/backend. |
| G7 | **Pas de lecture du wallet / politique par l'agent** via l'API. | L'agent ne peut pas connaître son budget restant avant de commander. | Backend : `GET /wallet` (solde, réservé, limites restantes) sous `missions:read`. Permettrait un vrai `estimate_mission()`. |
| G8 | **Une identité agent = un compte.** | Plusieurs agents d'un même propriétaire = plusieurs comptes. | Suffisant pour la V1 (une clé par agent). À terme : plusieurs wallets par compte. |
| G9 | Pas de webhooks. | Suivi par polling. | V1 : polling. V2 : webhooks / notifications MCP. |
| G10 | SDK Python obsolète (`/tasks`). | Hors périmètre MCP. | À réaligner sur `openapi.yaml` séparément. |

## 8. Architecture MCP V1 proposée

### 8.1 Principes

1. **Couche fine** : aucune logique métier ni financière dupliquée ; chaque tool = 1–2 appels API.
2. **Identité = clé API de l'agent** : le MCP ne détient aucun secret propre et
   ne peut rien faire que la clé ne permette déjà (scopes vérifiés par le backend).
3. **Aucune dépense implicite** : la création est en deux temps (aperçu → confirmation)
   et bornée par un plafond configuré côté opérateur.
4. **Erreurs fidèles** : codes du backend (`INSUFFICIENT_BALANCE`, `EXCEEDS_DAILY_LIMIT`…)
   et `request_id` remontés tels quels à l'agent.

### 8.2 Stack

- TypeScript, Node ≥ 20, `@modelcontextprotocol/sdk`, `zod` pour les schémas d'entrée/sortie.
- Transport **stdio** en V1 (Claude Desktop, Claude Code, agents locaux).
  Transport **Streamable HTTP** en V1.1 (agents distants) : la clé est alors lue
  depuis l'en-tête de chaque session, jamais stockée.
- Tests : `vitest` avec `fetch` simulé (aucun appel réseau réel).

### 8.3 Arborescence

```
src/
  index.ts              point d'entrée stdio
  server.ts             création du McpServer, enregistrement des tools
  config.ts             lecture/validation de l'environnement
  api/
    client.ts           client HTTP typé (X-API-Key, X-Request-Id, timeout, 429/Retry-After)
    types.ts            Mission, Assignment, ApiError (alignés sur openapi.yaml)
  domain/
    missionInput.ts     entrée MCP → CreateMissionRequest (gabarit description, cents)
    missionStatus.ts    agrégation mission + assignments → statut lisible par un agent
  safety/
    spendGuard.ts       plafond par mission, confirmation explicite
    dedupe.ts           clé d'idempotence + déduplication locale
  tools/
    createMission.ts  getMission.ts  listMissions.ts
    getMissionStatus.ts  getMissionResult.ts
test/
docs/ARCHITECTURE.md
```

### 8.4 Configuration

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `AIWORKPAY_API_URL` | `https://<ref>.supabase.co/functions/v1` | requis |
| `AIWORKPAY_API_KEY` | clé agent `aiwp_…` (identité + scopes) | requis |
| `AIWORKPAY_MAX_MISSION_CENTS` | plafond total par mission, appliqué **avant** l'appel API | `5000` |
| `AIWORKPAY_REQUIRE_CONFIRMATION` | création en deux temps | `true` |
| `AIWORKPAY_MAX_CREATIONS_PER_HOUR` | frein anti-boucle côté MCP | `10` |

Le plafond MCP s'ajoute à la politique de dépense serveur ; il ne la remplace pas.

### 8.5 Tools V1

| Tool | API | Annotations MCP |
| --- | --- | --- |
| `create_mission` | `POST /missions` | `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true` |
| `get_mission` | `GET /missions/{id}` | `readOnlyHint: true` |
| `list_missions` | `GET /missions` | `readOnlyHint: true` |
| `get_mission_status` | `GET /missions/{id}` + `GET /missions/{id}/assignments` | `readOnlyHint: true` |
| `get_mission_result` | `GET /missions/{id}/assignments` | `readOnlyHint: true` |

**`create_mission`** — entrée :

```ts
{
  type: "physical_verification" | "photo" | "phone_call" | "data_collection" | "other",
  title: string,                 // ≤ 200
  instructions: string,          // corps de la mission
  location?: { city?: string, address?: string, country?: string },
  deliverables?: string[],       // ex. ["photo de la façade", "horaires", "date/heure"]
  unit_price: number,            // montant décimal par exécution, ex. 12.50
  currency: "EUR" | "USD",       // doit correspondre au wallet
  slots?: number,                // défaut 1 (ex. 20 commerces = 20 slots)
  deadline: string,              // ISO 8601, futur
  priority?, expertise_required?, skills_required?,
  client_reference?: string,     // identifiant métier de l'agent → idempotence
  confirm?: boolean              // false/absent = aperçu, aucune dépense
}
```

Comportement :
1. Valide l'entrée (zod), convertit en centimes, calcule `total = unit × slots`.
2. Refuse si `total > AIWORKPAY_MAX_MISSION_CENTS` (`MCP_BUDGET_CAP_EXCEEDED`).
3. Si `confirm !== true` (et confirmation requise) : renvoie un **aperçu** (montant
   total débité, devise, description générée, rappel « débit immédiat en séquestre »)
   sans appeler l'API. Si le client supporte l'*elicitation* MCP, la confirmation
   peut être demandée directement à l'humain.
4. Sinon : `POST /missions` avec `Idempotency-Key` dérivée de `client_reference`
   (ou du hash de la requête) et `X-Request-Id`.
5. Renvoie `mission`, `debit`, `requires_human_validation`, `request_id`.

`type`, `location` et `deliverables` sont rendus dans `description` via un gabarit
fixe (écart G4), pour que le payworker voie exactement ce qui est attendu.

**`get_mission_status`** — sortie normalisée pour un agent :

```ts
{
  mission_id, status,           // open | in_progress | awaiting_review | completed | expired
  slots: { total, taken, submitted, settled, in_progress, available },
  deadline, is_past_deadline,
  next_action                   // ex. "2 exécutions attendent votre validation"
}
```

**`get_mission_result`** — les exécutions `submitted` / `settled` :
`{ assignment_id, status, submission, submission_json?, attempts, submitted_at, settled_at }`.
`submission_json` est rempli si la preuve est un JSON valide (convention recommandée
aux payworkers dans le gabarit).

### 8.6 Hors V1 (déjà possibles, à ajouter ensuite)

| Tool | Dépend de |
| --- | --- |
| `approve_result` → `/assignments/{id}/validate` | Disponible. Libère un paiement : même mécanisme de confirmation que la création. **Recommandé en V1.1**, sinon le travail n'est payé qu'à l'expiration. |
| `request_revision` → `/assignments/{id}/revise` | Disponible, sans mouvement d'argent. |
| `close_expired_mission` → `/missions/{id}/expire` | Disponible. |
| `cancel_mission` | **G1** (backend). |
| `estimate_mission`, `get_wallet` | **G7** (backend). |
| `find_worker`, `assign_worker`, `rate_worker` | Nouveaux endpoints backend (matching, réputation serveur). |
| `release_payment` | Couvert par `approve_result` (le modèle libère par exécution). |

### 8.7 Sécurité — synthèse

| Exigence | Où elle est assurée |
| --- | --- |
| Authentification | Backend (clé hachée). Le MCP transmet la clé, ne la logue jamais. |
| Permissions / scopes | Backend (`ROUTE_RULES`). Recommandation : clé MCP avec `missions:read` + `missions:write` seulement en V1 ; jamais `payments:fund`. |
| Budget maximum | Serveur (politique de dépense) **+** plafond MCP par mission. |
| Validation explicite | MCP (aperçu → `confirm`) ; backend à compléter (G3). |
| Idempotence | MCP (clé + dédup locale) ; backend à compléter (G2). |
| Journalisation | Backend (`audit_log`, request-id) ; MCP : logs JSON sur **stderr** (stdout réservé au protocole), clé masquée. |
| Traçabilité | `X-Request-Id` généré par appel et renvoyé à l'agent ; `agent_ref` dans les réponses. |
| Contrôle des résultats | Révision/validation par l'agent (V1.1) ; paiement automatique à l'expiration du travail soumis. |
| Anti-abus | Backend 120 req/min ; MCP `AIWORKPAY_MAX_CREATIONS_PER_HOUR` + dédup. |

## 9. Points à trancher avant implémentation

1. Confirmer que **`aiworkpay` (Supabase)** est bien le backend de référence.
2. `cancel_mission` : ajouter la RPC backend (G1) maintenant, ou la reporter ?
3. Inclure `approve_result` / `request_revision` dès la V1 ?
4. Idempotence (G2) et blocage `requires_human_validation` (G3) : à traiter côté backend en parallèle ?
5. Devise MAD : besoin produit à court terme ?
