# AIWorkPay MCP Server — Analyse de l'existant et architecture V1

> Statut : **V1, V1.1, V1.2, fichiers de preuve et V1.3 implémentés** (V1.1 : I1, I2 ; V1.2 : I3–I6 et transport HTTP ; V1.3 : outils `get_account` et `list_transactions`). Backend : [Aiworkpay-v2#1](https://github.com/cortexAI-2025/Aiworkpay-v2/pull/1) (B1–B4). MCP : ce dépôt.
> Les écarts entre la proposition initiale et l'implémentation sont signalés par **[V1]**.
> Backend de référence : **`cortexAI-2025/Aiworkpay-v2`** @ `eb90e1b` (2026-09-24).

## 1. Architecture existante

```
Navigateur / app Android (WebView)
        │  session NextAuth (cookie)
        ▼
Next.js 15 (App Router) ── middleware : protège /dashboard
  ├─ pages /dashboard/*            (rendu serveur, Prisma direct)
  ├─ app/api/*                     (route handlers REST)
  │     ├─ missions                 POST/GET  ← clé API agent (Bearer awp_…)
  │     ├─ missions/[id]/accept     PUT       ← session payworker
  │     ├─ missions/[id]/status     PATCH     ← session payworker / admin
  │     ├─ apikeys, apikeys/[id]    ← session admin
  │     ├─ payments/*               ← session (Stripe Connect, portail)
  │     └─ stripe/webhooks          ← signature Stripe
  ▼
Prisma 5 → PostgreSQL           Stripe (PaymentIntent, Connect, Transfers)
```

Stack : Next.js 15, React 18, NextAuth v5 (credentials + OAuth), Prisma 5,
PostgreSQL, Stripe, Resend, zod. Déploiement Docker (`prisma migrate deploy`
au démarrage), sonde `GET /api/health`.

## 2. Endpoints existants

| Méthode | Route | Auth | Effet |
| --- | --- | --- | --- |
| POST | `/api/missions` | `Bearer awp_…` (clé API) | Crée la mission (`PAYMENT_PENDING`) + un **PaymentIntent Stripe**. Avec `paymentMethodId` : **débit immédiat** de la carte. Sinon renvoie un `clientSecret` à confirmer. |
| GET | `/api/missions?limit&skip` | clé API | Missions créées par **cette clé**. (Le filtre `status` est ignoré dans ce cas.) |
| GET | `/api/missions?status` | session | Marketplace (défaut `PUBLISHED`). |
| PUT | `/api/missions/{id}/accept` | session payworker onboardé Stripe | `PUBLISHED → ASSIGNED` (compare-and-set). |
| PATCH | `/api/missions/{id}/status` | session payworker assigné / admin | Payworker : `ASSIGNED → IN_PROGRESS → DELIVERED`. Admin : `DELIVERED → COMPLETED` (split 90/10 + transfert Stripe), `* → CANCELED` (remboursement / annulation du PI). |
| GET/POST | `/api/apikeys` | session **admin** | Lister / générer une clé. |
| DELETE | `/api/apikeys/{id}` | session admin | Révoquer une clé. |
| POST | `/api/stripe/webhooks` | signature Stripe | `payment_intent.succeeded → PUBLISHED`, `payment_failed → CANCELED`, `transfer.created → payout SUCCEEDED`. |

**Il n'existe aucune route API pour lire une mission par id**, ni pour livrer
un résultat, ni pour qu'un agent valide ou annule.

## 3. Modèles (Prisma)

- **User** : `role ∈ {PAYWORKER, ADMIN}` (admin = email listé dans `ADMIN_EMAILS`),
  compte Stripe Connect (`stripeAccountId`, `stripeAccountOnboarded`). Pas de rôle « agent ».
- **ApiKey** = **l'identité de l'agent** : `key` (en clair), `label`, `active`,
  `stripeCustomerId` (un client Stripe par agent), `createdByUserId` (l'admin propriétaire).
- **Mission** : `title`, `description`, `budget` (Decimal 10,2), `currency` (3 lettres, défaut EUR),
  `deadline`, `priority`, `status`, `stripePaymentIntentId`, `platformFeeAmount`,
  `payworkerAmount`, `createdByApiKeyId`, `assignedToUserId` (**un seul exécutant**).
- **MissionStatus** : `PAYMENT_PENDING → PUBLISHED → ASSIGNED → IN_PROGRESS → DELIVERED → COMPLETED`, et `CANCELED`.
  (`CREATED` existe dans l'enum mais n'est jamais utilisé.)
- **MissionAttachment** : `url`, `filename`, `mimeType`, `size` — affiché dans le dashboard
  mais **aucune route ne permet d'en créer**.
- **Transaction** : `AGENT_PAYMENT`, `PLATFORM_FEE`, `PAYWORKER_PAYOUT` (+ legacy), statut, ids Stripe.

## 4. Authentification

- **Agents** : `Authorization: Bearer awp_<72 hex>`, comparée **en clair** en base
  (`findFirst({ key, active: true })`). Pas de scopes, pas d'expiration, pas de
  `last_used`, pas de rate limiting. Clés créées uniquement par un admin.
- **Humains** : NextAuth (JWT de session), email/mot de passe, téléphone, OAuth.
- Conséquence pour le MCP : **une clé API = un agent**. C'est suffisant pour
  donner à chaque agent sa propre identité dès la V1 ; les permissions fines manquent.

## 5. Paiements

1. Création de mission → PaymentIntent du montant `budget` sur le client Stripe de la clé.
2. Paiement confirmé (webhook) → mission `PUBLISHED`. Les fonds sont encaissés sur la plateforme.
3. Admin passe `DELIVERED → COMPLETED` → transaction atomique (fee 10 % + payout 90 %
   `PENDING`) puis `stripe.transfers.create` vers le compte Connect du payworker
   (clé d'idempotence `mission_payout_{id}`).
4. Annulation (admin) → remboursement si payé, sinon annulation du PI.

Points forts : publication conditionnée au paiement confirmé par webhook,
compare-and-set à l'acceptation et à la complétion, idempotence Stripe sur
transferts/remboursements.

## 6. Ce qui est directement réutilisable

- `POST /api/missions` et `GET /api/missions` avec la clé API : création et liste.
- La clé API comme identité d'agent (avec un client Stripe dédié par agent).
- Le cycle de statuts et le paiement conditionnant la publication : **aucune mission
  n'est publiée sans paiement explicite**, ce qui va dans le sens du « pas de dépense implicite ».
- Le split 90/10, les transferts Connect, les remboursements.
- `MissionAttachment` comme support des pièces jointes (brief et preuves).

## 7. Ce qui manque pour exposer proprement AIWorkPay via MCP

### 7.1 Bloquant pour la V1 (côté backend, ajouts sans casser l'existant)

| # | Manque | Pourquoi c'est bloquant | Ajout proposé dans `Aiworkpay-v2` |
| --- | --- | --- | --- |
| B1 | **Lecture d'une mission par id** pour un agent | `get_mission` / `get_mission_status` impossibles (sinon il faut paginer toute la liste). | `GET /api/missions/{id}` (clé API, limité aux missions de la clé ; 404 sinon). |
| B2 | **Aucun résultat livrable** : `DELIVERED` est un simple changement de statut, sans contenu. | `get_mission_result` n'a rien à renvoyer : c'est le cœur de l'objectif. | Champs `Mission.result` (Json), `resultNote` (texte), `deliveredAt` ; route payworker `POST /api/missions/{id}/deliver` `{ note, data?, attachments?[] }` qui passe à `DELIVERED`. `MissionAttachment.kind ∈ {BRIEF, PROOF}`. |
| B3 | **Pas d'idempotence** à la création | Un retry réseau de l'agent = deux missions et deux paiements. | En-tête `Idempotency-Key` → colonne `Mission.idempotencyKey`, unique par `createdByApiKeyId` ; un doublon renvoie la mission existante. |
| B4 | **Payer sans humain ni secret Stripe** | Le `clientSecret` doit être confirmé par Stripe.js, inaccessible à la plupart des agents ; `paymentMethodId` débite immédiatement. | Option `payment: "checkout"` : la création renvoie une **URL Stripe Checkout** que l'agent transmet à son propriétaire humain → validation explicite naturelle. `paymentMethodId` reste disponible mais derrière un garde-fou (§ 8.5). |

### 7.2 Important (V1.1)

| # | Manque | Ajout proposé |
| --- | --- | --- |
| I1 | L'agent ne peut **ni valider ni refuser** la livraison (admin seulement). | `POST /api/missions/{id}/approve` (clé API propriétaire, `DELIVERED → COMPLETED`, réutilise la logique 90/10 existante) et `POST /api/missions/{id}/request-changes` (`DELIVERED → IN_PROGRESS` + feedback). |
| I2 | L'agent ne peut **pas annuler** (admin seulement). | `POST /api/missions/{id}/cancel` (clé API propriétaire, uniquement `PAYMENT_PENDING` ou `PUBLISHED` ; réutilise le remboursement existant). |
| I3 | Clés API **en clair**, sans scopes ni expiration. | Stocker `keyHash` (SHA-256) + `keyPrefix`, `scopes String[]` (`missions:read`, `missions:write`, `missions:approve`), `expiresAt`, `lastUsedAt`. Migration : révoquer ou re-hacher. |
| I4 | Pas de plafond de dépense par agent. | `ApiKey.maxMissionBudget`, `ApiKey.monthlyBudget` vérifiés à la création. |
| I5 | Pas de rate limiting. | Limite par clé sur `POST /api/missions` (ex. 10/heure), réponse `429` + `Retry-After`. |
| I6 | Erreurs en texte libre (`{ error: "…" }`). | Ajouter un `code` stable (`MISSION_NOT_FOUND`, `INVALID_BODY`…) sans retirer `error`. |
| I7 | Pas de champs structurés (type, lieu, livrables attendus). | `Mission.type`, `Mission.location` (Json), `Mission.requirements` (Json : photos, champs, horodatage…). En attendant, le MCP les sérialise dans `description`. |

### 7.3 Petits défauts relevés au passage

- `GET /api/missions` avec clé API ignore `?status=`.
- `GET /api/missions?status=XYZ` (session) : statut non validé → erreur Prisma → 500.
- Si `stripe.paymentIntents.create` échoue, la mission reste orpheline en `PAYMENT_PENDING`.
- `payment_intent.payment_failed` annule définitivement la mission alors qu'un PI peut être retenté.
- `Math.round(budget * 100)` est faux pour les devises sans décimales (JPY…) ; à vérifier
  pour le **MAD** (décimal, OK pour les paiements Stripe, mais les transferts Connect
  doivent être testés).

## 8. Architecture MCP V1 proposée

### 8.1 Principes

1. **Couche fine** : chaque tool = 1 appel HTTP vers `Aiworkpay-v2`. Aucune logique
   de paiement, de statut ou de commission dans le MCP.
2. **Identité = clé API de l'agent**. Le MCP ne détient aucun secret propre
   (ni `STRIPE_SECRET_KEY`, ni `DATABASE_URL`) et ne peut rien faire que la clé ne permette.
3. **Aucune dépense implicite** : création en deux temps (aperçu → `confirm: true`),
   plafond par mission, paiement par lien Checkout par défaut.
4. **Statuts lisibles par un agent** : traduction des statuts internes + « prochaine action ».

### 8.2 Stack

- TypeScript, Node ≥ 20, `@modelcontextprotocol/sdk`, `zod` (déjà utilisé par v2).
- Transport **stdio** en V1 (Claude Desktop, Claude Code, agents locaux).
  **Streamable HTTP** en V1.1 : la clé est lue dans l'en-tête de chaque session, jamais persistée.
  À terme, ce transport pourrait être monté directement dans Next.js (`app/api/mcp/route.ts`).
- Tests : `vitest`, `fetch` simulé.

### 8.3 Arborescence

```
src/
  index.ts               point d'entrée stdio
  server.ts              McpServer, instructions, enregistrement des tools
  config.ts              variables d'environnement (zod)
  log.ts                 logs JSON sur stderr
  api/
    client.ts            client HTTP : Bearer, Idempotency-Key, X-Request-Id, timeout, erreurs typées
    types.ts             Mission, MissionStatus… (alignés sur prisma/schema.prisma)
  domain/
    missionInput.ts      entrée MCP → corps POST /api/missions (gabarit de description, clé d'idempotence)
    missionStatus.ts     statut interne → statut agent + next_action
  safety/
    spendGuard.ts        plafond, devises autorisées, deadline
    creationLimiter.ts   limite de créations par heure (les rejeux passent)
  tools/
    createMission.ts     create_mission
    readMissions.ts      get_mission, list_missions, get_mission_status, get_mission_result
    result.ts            format des résultats et des erreurs
test/                    unitaires + client MCP réel sur une fausse API
docs/ARCHITECTURE.md
```

### 8.4 Configuration

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `AIWORKPAY_BASE_URL` | ex. `https://aiworkpay.fr` | requis |
| `AIWORKPAY_API_KEY` | clé agent `awp_…` | requis |
| `AIWORKPAY_MAX_MISSION_BUDGET` | plafond par mission, vérifié avant l'appel | `50` |
| `AIWORKPAY_ALLOWED_CURRENCIES` | ex. `EUR,MAD` | `EUR` |
| `AIWORKPAY_REQUIRE_CONFIRMATION` | création en deux temps | `true` |
| `AIWORKPAY_TIMEOUT_MS` | délai maximal d'un appel API | `15000` |
| `AIWORKPAY_MAX_CREATIONS_PER_HOUR` | frein anti-boucle | `10` |

### 8.5 Tools V1

| Tool | Appel | Disponible | Annotations |
| --- | --- | --- | --- |
| `create_mission` | `POST /api/missions` | **oui** (idempotence et Checkout : B3, B4) | `destructiveHint`, `openWorldHint` |
| `list_missions` | `GET /api/missions` | **oui** | `readOnlyHint` |
| `get_mission` | `GET /api/missions/{id}` | après **B1** | `readOnlyHint` |
| `get_mission_status` | `GET /api/missions/{id}` | après **B1** | `readOnlyHint` |
| `get_mission_result` | `GET /api/missions/{id}` | après **B2** | `readOnlyHint` |

**`create_mission`** — entrée :

```ts
{
  type: "physical_verification" | "photo" | "phone_call" | "data_collection" | "other",
  title: string,                     // 3–200
  instructions: string,              // ≥ 10
  location?: { city?: string, address?: string, country?: string },
  deliverables?: string[],           // ex. ["photo de la façade", "horaires", "date/heure"]
  budget: number,                    // montant total payé pour la mission
  currency: string,                  // doit figurer dans AIWORKPAY_ALLOWED_CURRENCIES
  deadline: string,                  // ISO 8601, futur
  priority?: "low" | "medium" | "high",
  client_reference?: string,         // identifiant métier → Idempotency-Key
  confirm?: boolean                  // absent/false = aperçu, aucun appel API
}
```

Comportement :
1. Validation zod ; refus si `budget > AIWORKPAY_MAX_MISSION_BUDGET` ou devise non autorisée.
2. Sans `confirm: true` : renvoie un **aperçu** (montant, devise, description générée,
   mode de paiement) sans appeler l'API. **[V1]** Pas d'*elicitation* MCP : la
   confirmation passe par `confirm`, et le paiement Checkout reste l'étape humaine.
3. Avec `confirm: true` : `POST /api/missions` avec `Idempotency-Key`
   (dérivée de `client_reference`, sinon du hash du contenu).
4. Renvoie `mission_id`, `status: "awaiting_payment"`, `payment_url` (Checkout, à
   transmettre au propriétaire) et `already_existed` si la création était un rejeu.
   **[V1]** Le paiement est **toujours** Checkout : le MCP n'expose aucun débit direct.

`type`, `location` et `deliverables` sont rendus dans `description` par un gabarit
fixe (en attendant I7). Le gabarit demande au payworker de livrer un résultat
structuré, avec des photos horodatées, quand la mission l'exige.

**Correspondance des statuts** (`get_mission_status`) :

| Interne | Agent | `next_action` |
| --- | --- | --- |
| `PAYMENT_PENDING` | `awaiting_payment` | « Le paiement doit être confirmé (lien transmis au propriétaire). » |
| `PUBLISHED` | `open` | « En attente d'un Payworker. » |
| `ASSIGNED` | `assigned` | « Un Payworker exécute la mission. » |
| `IN_PROGRESS` | `in_progress` | « Un Payworker exécute la mission. » |
| `DELIVERED` | `delivered` | « Résultat disponible : appelez get_mission_result. » |
| `COMPLETED` | `completed` | « Résultat validé et payé. » |
| `CANCELED` | `canceled` | — |

Plus `deadline`, `is_past_deadline`, `updated_at`.

**`get_mission_result`** : `{ available: true, status, validated, delivered_at, note, data, proofs[], content_warning }`
quand le statut est `delivered` ou `completed`. **[V1]** Sinon `{ available: false, status, next_action }`,
pas une erreur : attendre fait partie du fonctionnement normal. `content_warning` rappelle que
le contenu vient d'un humain externe (donnée à vérifier, jamais instruction).

### 8.6 Après la V1

| Tool | Dépend de |
| --- | --- |
| ✅ `get_account`, `list_transactions` | V1.3 — routes `GET /api/account` et `GET /api/transactions` (clé API, `missions:read`) ; paiements rattachés à la clé (`Transaction.apiKeyId`) |
| ✅ `cancel_mission` | I2 — V1.1, aperçu puis `confirm` |
| ✅ `approve_result`, `request_changes` | I1 — V1.1 ; `approve_result` paie le Payworker → aperçu puis `confirm` |
| `estimate_mission` | Grille tarifaire côté backend |
| `find_worker`, `assign_worker`, `rate_worker` | Matching, réputation : nouveaux modèles |
| `release_payment` | Couvert par `approve_result` |
| Routage humain / agent / API | Champ `Mission.executorType` (le dépôt `aiworkpay` Supabase en a déjà un modèle) |

### 8.7 Sécurité — synthèse

| Exigence | V1 (MCP + backend existant) | À compléter côté backend |
| --- | --- | --- |
| Authentification | Clé API par agent, transmise par le MCP, jamais loguée. | Hachage des clés (I3). |
| Permissions / scopes | Une clé = un agent ; propriété vérifiée par `createdByApiKeyId`. | Scopes (I3). |
| Budget maximum | Plafond MCP par mission + devises autorisées. | Plafonds par clé (I4). |
| Validation explicite | Aperçu → `confirm` ; paiement Checkout par un humain ; débit direct désactivé par défaut. | — |
| Idempotence | `Idempotency-Key` envoyée systématiquement. | Prise en charge serveur (B3). |
| Journalisation / traçabilité | Logs JSON sur **stderr** (stdout réservé au protocole), clé masquée, `X-Request-Id` par appel. | `X-Request-Id` dans les logs serveur. |
| Contrôle des résultats | Lecture du résultat livré. | Validation / refus par l'agent (I1). |
| Anti-abus | Limite de créations par heure côté MCP. | Rate limiting serveur (I5). |

### 8.8 Ce qu'on peut reprendre du dépôt `aiworkpay` (Supabase)

Ce dépôt, plus avancé sur la sécurité, contient des modèles directement transposables
à v2 : clés hachées avec scopes et quota (`verify_api_key`), politique de dépense
par agent, mapping d'erreurs avec codes stables, rate limiting, `X-Request-Id`
et `executor_type`. Il servira de référence pour I3 à I6, pas de dépendance.

## 9. Plan proposé

1. ✅ **PR backend `Aiworkpay-v2`** : B1–B4 + correctifs § 7.3 — [Aiworkpay-v2#1](https://github.com/cortexAI-2025/Aiworkpay-v2/pull/1).
2. ✅ **MCP V1** dans ce dépôt : 5 tools, garde-fous, tests unitaires et d'intégration, test de bout en bout en stdio contre le backend.
3. ✅ **V1.1** : I1 (`approve_result`, `request_changes`, 3 révisions au maximum) et I2 (`cancel_mission` avant engagement d'un Payworker), dans la même PR backend.
4. ✅ **V1.2** : I3 (clés hachées, scopes `missions:read|write|approve`, expiration, dernière utilisation), I4 (plafond par mission et budget mensuel par clé, vérifiés atomiquement), I5 (limites de débit en base : requêtes et créations par clé, échecs d'authentification par IP), I6 (codes stables + `hint` côté MCP), transport Streamable HTTP sans état (clé par requête, contrôle `Host`/`Origin`, limite de créations par agent).
5. ✅ **Fichiers de preuve** : envoi par le Payworker (JPEG, PNG, WebP, HEIC, PDF, type vérifié sur le contenu, 10 Mo, 20 par mission), analyse antivirus ClamAV obligatoire avant stockage (refus si menace ou antivirus indisponible), stockage privé S3-compatible ou local, téléchargement contrôlé (agent propriétaire après livraison, Payworker assigné, admin) ; tool MCP `get_proof_file` (photos rendues comme images, PDF comme ressources).

6. ✅ **V1.3** : `get_account` (permissions, plafonds, budget du mois, payé / remboursé, missions par statut, plafond effectif d'une création) et `list_transactions`, lecture seule ; routes backend `GET /api/account` et `GET /api/transactions` ; `PAYMENT_PROVIDER_UNAVAILABLE` (502) renvoyé aussi quand Stripe est injoignable à la création ; indication (`hint`) pour ce code et pour une instance sans ces routes.

## 10. Décisions prises

1. Backend de référence : `Aiworkpay-v2` ; PR backend minimale avant le MCP.
2. Paiement : **lien Checkout payé par un humain**, seul mode exposé par le MCP.
3. Annulation (I2) et validation par l'agent (I1) : livrées en V1.1. L'agent ne peut annuler qu'avant l'engagement d'un Payworker ; ensuite, seule l'équipe AIWorkPay peut le faire.
4. Devises : `EUR` par défaut, configurable (`AIWORKPAY_ALLOWED_CURRENCIES`) ; le MAD reste à tester côté Stripe Connect.
5. Les paiements d'un agent sont rattachés à **sa clé** (`Transaction.apiKeyId`), pas à l'administrateur qui l'a créée : `get_account` et `list_transactions` s'appuient sur cette identité technique.
6. **Webhooks sortants non exposés par le MCP.** Ils notifient le serveur de l'agent (`PUT /api/webhook`, signature HMAC, reprises) ; leur secret ne doit pas transiter par le contexte d'un modèle. Le MCP reste en interrogation (`get_mission_status`).
