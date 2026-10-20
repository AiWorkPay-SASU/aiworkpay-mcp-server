# Changelog

## Non publié

- **Démarrage en production** (`NODE_ENV=production`, transport HTTP) : refus de démarrer, sans afficher de secret, si `MCP_TRUSTED_PROXY_HOPS` n'est pas posé
  explicitement (1 à 5, plus de valeur implicite), si `AIWORKPAY_FORWARD_TOKEN` est absent, trop court (< 16) ou non résolu, si `AIWORKPAY_BASE_URL` n'est pas une
  adresse https publique, si `MCP_ALLOWED_HOSTS` ne contient que `localhost`, si `AIWORKPAY_API_KEY` est définie ou si la confirmation en deux temps est désactivée.
  Développement, tests et stdio inchangés. Tests unitaires et tests de démarrage réels.

## 0.7.0

- **Sécurité** : après 10 échecs d'authentification en 10 minutes depuis une même adresse, `429` sans interroger AIWorkPay ;
  une clé refusée est mémorisée une minute. L'adresse du client est celle que les proxys de confiance ont ajoutée à
  `X-Forwarded-For` (`MCP_TRUSTED_PROXY_HOPS`), jamais celle que le client a écrite. Avec `AIWORKPAY_FORWARD_TOKEN`, l'adresse
  réelle est transmise à AIWorkPay (qui limite alors par client, et non pour toute l'infrastructure MCP).
- Le schéma d'authentification `bearer` est accepté en minuscules (RFC 9110) ; le préfixe `awp_` reste sensible à la casse.
- `server.json` pour le registre MCP officiel (point d'accès distant, en-tête `Authorization` secret).
- Tests : bout en bout contre le vrai backend (HTTP et stdio, 10 scénarios), contrat (README, annotations, version),
  durcissement HTTP, registre. `scripts/smoke-remote.mjs` pour vérifier un déploiement sans rien créer.
- Dépendances : `@modelcontextprotocol/sdk` 1.32.1.

## 0.6.0

- Outils `get_account` (permissions, plafonds, budget du mois, plafond effectif d'une création) et `list_transactions`
  (paiements de la clé, remboursements). Lecture seule ; routes `GET /api/account` et `GET /api/transactions` d'AIWorkPay.
- Indications pour `PAYMENT_PROVIDER_UNAVAILABLE` et pour une instance sans ces routes.

## 0.5.0 et avant

Création en deux temps, lecture, validation, corrections, annulation, preuves, transport Streamable HTTP, intégration Ruflo
(voir l'historique Git).
