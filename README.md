# AIWorkPay MCP Server

Serveur [MCP](https://modelcontextprotocol.io) qui permet à un agent IA de **déléguer à un
humain** ce qu'il ne peut pas faire seul : vérification sur place, photos, appel
téléphonique, collecte d'informations locales, contrôle de documents. L'agent crée une
mission, suit son exécution et récupère un résultat structuré, puis poursuit son workflow.

```
Agent IA ──MCP (stdio ou HTTP)──► aiworkpay-mcp-server ──HTTPS + clé agent──► AIWorkPay (Aiworkpay-v2)
                                                                        │
                                                    Payworker humain ◄──┘ → résultat + preuves
```

Le serveur est une **couche fine** : aucune logique de paiement ni de statut n'y est
dupliquée. Il n'utilise que la clé API de l'agent, et ne peut rien faire de plus qu'elle.
Architecture et choix détaillés : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tools

| Tool | Rôle |
| --- | --- |
| `create_mission` | Prépare (aperçu) puis crée une mission ; renvoie un lien de paiement Stripe. |
| `get_mission` | Détail d'une mission. |
| `list_missions` | Missions de l'agent, filtrables par statut. |
| `get_mission_status` | Où en est la mission, et quoi faire ensuite (`next_action`). |
| `get_mission_result` | Compte rendu, données structurées et liste des preuves livrés par le Payworker. |
| `get_account` | Votre propre compte : permissions de la clé, plafonds, budget dépensé et restant ce mois-ci, payé / remboursé, missions par statut, et **`effective_max_budget`** (la plus grande mission que vous pouvez créer maintenant : le plus bas des plafonds applicables). À consulter avant une commande importante. |
| `list_transactions` | Vos paiements, du plus récent au plus ancien : montant, devise, mission, et `refunded` (la mission a été annulée, donc remboursée). Filtrable par `mission_id`. |
| `get_proof_file` | Lit un fichier de preuve envoyé par le Payworker : les photos reviennent comme **images** que l'agent peut regarder, les PDF comme documents intégrés (15 Mo au maximum). Chaque preuve indique son analyse antivirus (`virus_scan: clean`, ou `not_scanned` avec un avertissement si l'analyse était désactivée côté AIWorkPay). |
| `approve_result` | Accepte le résultat livré : paie le Payworker (90 %). Aperçu puis `confirm`. Irréversible. |
| `request_changes` | Renvoie le résultat au Payworker avec un commentaire (3 fois au maximum). Aucun mouvement d'argent. |
| `cancel_mission` | Retire une mission qu'aucun Payworker n'a prise : lien de paiement fermé, ou remboursement. Aperçu puis `confirm`. |
| `prepare_workforce_handoff` | Intégration Ruflo : prépare les arguments de `create_mission` avec une référence stable tirée des identifiants swarm/tâche/sous-tâche. Ne crée rien, n'appelle pas l'API. |
| `get_workforce_handoff` | Intégration Ruflo : phase de la mission (`awaiting_payment`, `waiting_for_worker`, `awaiting_review`, `completed`, `canceled`) et indique quand reprendre la tâche dépendante. Lecture seule. |

Statuts exposés : `awaiting_payment → open → assigned → in_progress → delivered → completed`, ou `canceled`.

### Exemple

```jsonc
// 1. Aperçu : rien n'est créé
create_mission({
  "type": "physical_verification",
  "title": "Vérifier une pharmacie à Casablanca",
  "instructions": "Aller sur place et vérifier qu'elle existe et est ouverte.",
  "location": { "city": "Casablanca", "address": "12 bd Example" },
  "deliverables": ["Photo de la façade", "Horaires d'ouverture"],
  "budget": 30, "currency": "EUR",
  "deadline": "2026-10-10T18:00:00+01:00",
  "client_reference": "casa-pharma-001"
})
// 2. Même appel avec "confirm": true → { "mission_id": "…", "status": "awaiting_payment", "payment_url": "https://checkout.stripe.com/…" }
// 3. Le propriétaire humain paie → la mission est publiée
// 4. get_mission_status(...) jusqu'à "delivered", puis get_mission_result(...)
// 5. approve_result(...) (aperçu, puis "confirm": true) ou request_changes(..., "feedback": "…")
```

## Sécurité

- **Aucune dépense sans humain** : une mission n'est publiée qu'après paiement de la page
  Stripe Checkout par une personne. Le serveur n'envoie jamais de moyen de paiement.
- **Confirmation explicite** : `create_mission`, `approve_result` et `cancel_mission` ne font qu'un aperçu tant que `confirm` n'est pas `true`.
- **Plafonds de l'opérateur**, vérifiés avant tout appel : budget maximal par mission,
  devises autorisées, nombre de créations par heure.
- **Idempotence** : chaque création porte une `Idempotency-Key` dérivée de
  `client_reference` (ou du contenu). Un réessai ou une boucle ne crée jamais de doublon.
- **Une identité par agent** : chaque agent utilise sa propre clé `awp_…` et ne voit que ses missions.
  Côté AIWorkPay, chaque clé a ses **permissions** (`missions:read`, `missions:write`,
  `missions:approve`), ses **plafonds** (par mission, par mois) et son **débit** limité.
  Les refus remontent à l'agent avec un code stable et une indication (`hint`) sur quoi faire.
- **Compte en lecture seule, limité à la clé** : `get_account` et `list_transactions` ne montrent que ce que la clé
  de l'agent possède ; jamais le hash de la clé, un identifiant Stripe ni les données d'un autre agent.
- **Résultats non fiables par nature** : le contenu livré par un humain (texte, photos, PDF)
  est signalé comme donnée à vérifier, jamais comme instruction (protection contre
  l'injection de prompt).
- **La clé ne suit jamais une URL de la mission** : `get_proof_file` reconstruit le chemin
  de téléchargement à partir des identifiants, sur l'URL AIWorkPay configurée.
- **Journalisation** : JSON sur stderr (stdout est réservé au protocole), avec
  `X-Request-Id` par appel ; la clé et le contenu des missions ne sont jamais journalisés.

## Configuration

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `AIWORKPAY_BASE_URL` | — | URL de l'instance AIWorkPay (https ; http seulement pour localhost). |
| `AIWORKPAY_API_KEY` | — | Clé de l'agent (`awp_…`), générée par un admin AIWorkPay. |
| `AIWORKPAY_MAX_MISSION_BUDGET` | `50` | Budget maximal d'une mission. |
| `AIWORKPAY_ALLOWED_CURRENCIES` | `EUR` | Devises autorisées, séparées par des virgules. |
| `AIWORKPAY_REQUIRE_CONFIRMATION` | `true` | Aperçu obligatoire avant création. |
| `AIWORKPAY_MAX_CREATIONS_PER_HOUR` | `10` | Créations par heure glissante (`0` désactive la création). |
| `AIWORKPAY_TIMEOUT_MS` | `15000` | Délai maximal d'un appel à l'API. |

## Installation

Prérequis : Node.js 20+ et une instance AIWorkPay ([Aiworkpay-v2](https://github.com/AiWorkPay-SASU/Aiworkpay-v2))
incluant l'API agent, les fichiers de preuve et, pour `get_account` / `list_transactions`, les routes
`GET /api/account` et `GET /api/transactions`. Sur une instance plus ancienne ces deux outils répondent
`NOT_FOUND` avec une indication ; les autres fonctionnent.

```bash
npm ci
npm run build
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "aiworkpay": {
      "command": "node",
      "args": ["/chemin/vers/aiworkpay-mcp-server/dist/index.js"],
      "env": {
        "AIWORKPAY_BASE_URL": "https://app.aiworkpay.fr",
        "AIWORKPAY_API_KEY": "awp_…"
      }
    }
  }
}
```

Avec Claude Code : `claude mcp add aiworkpay -e AIWORKPAY_BASE_URL=https://app.aiworkpay.fr -e AIWORKPAY_API_KEY=awp_… -- node /chemin/vers/dist/index.js`

## Transport HTTP (agents distants)

Pour des agents qui ne tournent pas sur la même machine, le serveur expose le transport
MCP **Streamable HTTP** (sans état) : `POST /mcp`. Chaque requête porte la clé de son
agent, `Authorization: Bearer awp_…` ; le serveur n'en stocke aucune et la transmet
telle quelle à AIWorkPay, qui applique permissions et plafonds.

```bash
AIWORKPAY_BASE_URL=https://app.aiworkpay.fr \
MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=3333 \
MCP_ALLOWED_HOSTS=mcp.aiworkpay.fr \
npm run start:http
```

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MCP_HTTP_HOST` | `127.0.0.1` | Adresse d'écoute. |
| `MCP_HTTP_PORT` | `3333` | Port d'écoute. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Valeurs acceptées de l'en-tête `Host` (protection contre le DNS rebinding). |
| `MCP_ALLOWED_ORIGINS` | *(vide)* | Origines navigateur acceptées ; une requête avec un autre `Origin` est refusée. |
| `MCP_TRUSTED_PROXY_HOPS` | `1` | Nombre de proxys devant ce serveur (1 sur Railway seul, 2 avec Cloudflare) : l'adresse du client est l'entrée de `X-Forwarded-For` que ces proxys ont ajoutée, jamais celle que le client a écrite. `0` : adresse de la socket. |
| `AIWORKPAY_FORWARD_TOKEN` | *(vide)* | Secret partagé (16 caractères au moins) avec `TRUSTED_FORWARDER_TOKEN` d'AIWorkPay : ce serveur transmet l'adresse réelle de chaque client, pour que les limites de débit d'AIWorkPay s'appliquent par client et non à toute l'infrastructure MCP. |

Les variables `AIWORKPAY_*` (hors clé) s'appliquent aussi ; la limite de créations par
heure est comptée **par agent**. Déployez derrière un reverse proxy qui termine le
**TLS** : la clé ne doit jamais circuler en clair. `GET /healthz` sert de sonde.

Client MCP distant, par exemple :

```json
{
  "mcpServers": {
    "aiworkpay": {
      "type": "http",
      "url": "https://mcp.aiworkpay.fr/mcp",
      "headers": { "Authorization": "Bearer awp_…" }
    }
  }
}
```

### Démarrage en production : ce qui est obligatoire

Avec `NODE_ENV=production` (le `Dockerfile` le fixe), `node dist/httpMain.js` **refuse de démarrer** (code de sortie 1, une ligne de journal `config.refused` par problème) si :

| Réglage | Condition |
| --- | --- |
| `MCP_TRUSTED_PROXY_HOPS` | **posé explicitement**, entier de 1 à 5 : le nombre de proxys devant *ce* serveur (1 derrière Railway seul, 2 avec Cloudflare). Aucune valeur implicite en production. Il peut différer de `TRUSTED_PROXY_HOPS` du backend : chacun compte les proxys devant son propre service. |
| `AIWORKPAY_FORWARD_TOKEN` | présent, **16 caractères au moins**, et pas une référence non résolue (`${{…}}`) ni un modèle (`<…>`) |
| `AIWORKPAY_BASE_URL` | adresse **https publique** du backend (ni `http`, ni `localhost`) |
| `MCP_ALLOWED_HOSTS` | au moins un hôte public (le défaut n'accepte que `localhost`) |
| `AIWORKPAY_API_KEY` | **non définie** (chaque agent apporte sa clé ; une clé partagée donnerait à tous la même identité) |
| `AIWORKPAY_REQUIRE_CONFIRMATION` | pas à `false`/`0` |

Avertissements sans refus : plafonds d'opérateur laissés à leurs valeurs par défaut (50 par mission, 10 créations par heure, EUR) ; `MCP_HTTP_HOST` sur l'adresse de bouclage.
Les messages nomment les réglages, **jamais leurs valeurs** : ils peuvent être copiés dans un ticket. Le secret n'est ni écrit ni mesuré dans les journaux.
**Hors production** (développement, tests, `NODE_ENV` absent) et en transport **stdio**, rien de tout cela ne s'applique ; la valeur par défaut `MCP_TRUSTED_PROXY_HOPS=1` y reste.
Le secret doit être **le même** que `TRUSTED_FORWARDER_TOKEN` du backend : ce serveur ne peut pas le vérifier lui-même (un secret différent est ignoré par le backend sans erreur). Contrôler les deux services ensemble avec `scripts/check-vars.cjs` du dépôt backend avant de saisir les variables dans Railway.

### Protection contre les devinettes de clés

Après **10 échecs d'authentification en 10 minutes** depuis une même adresse, ce serveur répond `429` (avec `Retry-After`) sans
interroger AIWorkPay ; une clé refusée par AIWorkPay est aussi refusée localement pendant une minute. Sans cela, les
tentatives d'un attaquant épuiseraient la limite d'échecs qu'AIWorkPay applique à l'adresse du serveur MCP, partagée par
tous les agents. Avec `AIWORKPAY_FORWARD_TOKEN` configuré des deux côtés, AIWorkPay compte aussi par client.

### Vérifier un déploiement

`scripts/smoke-remote.mjs` contrôle un serveur déployé **sans rien créer ni payer** : `/healthz`, refus (sans clé, origine
étrangère, JSON invalide, autre schéma d'authentification), puis, avec une clé de test, `initialize`, `tools/list` (les 13
outils attendus) et `get_account` (lecture seule).

```bash
npm run smoke:remote -- https://mcp.aiworkpay.fr
AIWORKPAY_API_KEY=awp_… npm run smoke:remote -- https://mcp.aiworkpay.fr
```

## Suivre une mission : interrogation ou webhooks

Par le MCP, l'agent interroge `get_mission_status` (avec parcimonie : un humain met de quelques minutes à
plusieurs jours). Un agent qui a **son propre serveur** peut à la place être prévenu à chaque étape par
les **webhooks sortants** d'AIWorkPay (`mission.published`, `assigned`, `started`, `delivered`,
`changes_requested`, `completed`, `canceled`), signés en HMAC-SHA256 et retentés en cas d'échec.
Ils se configurent avec la même clé API (`PUT /api/webhook`, voir le README d'Aiworkpay-v2), **par le
serveur de l'agent et pas par ce MCP** : le secret de signature ne doit jamais passer par le contexte
du modèle. Après un événement `mission.delivered`, l'agent reprend avec `get_mission_result`.

## Développement

```bash
npm run typecheck
npm test        # tests unitaires + client MCP réel connecté en mémoire à une fausse API AIWorkPay
npm run build
E2E_CONTROL_URL=http://127.0.0.1:4100 npm run test:e2e   # bout en bout : vrai backend AiWorkPay + Stripe simulé
```

Le test de bout en bout (`test/e2e/`) a besoin de l'environnement isolé d'`Aiworkpay-v2` (`npm run e2e:harness` dans ce dépôt :
vrai serveur, PostgreSQL, Stripe simulé, Payworker de test). Il rejoue le scénario « horaires et photo de façade » par HTTP et par
stdio, et les refus (permissions, plafonds, isolation, annulation, panne Stripe, injection de consignes dans un résultat).


### Financial authorization

`confirm=true` is an agent instruction, not proof of human consent. A key with
`missions:approve` explicitly delegates irreversible result approval and payout.
Give agents read/write scopes only when a human must approve results in the dashboard.
Creation always uses Checkout; no payment method is sent by this MCP.

### Remote deployment

The Dockerfile runs the HTTP transport and accepts Railway's `PORT`. Set
`AIWORKPAY_BASE_URL` to the deployed **application** (for example
`https://app.aiworkpay.fr`), not the marketing website. Set `MCP_ALLOWED_HOSTS`
to the MCP service's public hostname and its healthcheck hostname if different.
Keep HTTPS at the proxy. No shared `AIWORKPAY_API_KEY` is needed in HTTP mode:
each client sends its own key. `/healthz` is liveness only; application readiness
is checked at the application's `/api/health`.

## Ruflo + AIWorkPay workforce

Intégration modulaire via deux serveurs MCP accessibles au même agent hôte.
`prepare_workforce_handoff` prépare un brief avec une référence stable issue des
identifiants swarm/tâche/sous-tâche ; `get_workforce_handoff` lit son état et son
résultat avant reprise. Aucun paiement ni orchestration Ruflo supplémentaire dans
ces outils. Configuration et procédure : [docs/RUFLO.md](docs/RUFLO.md).
