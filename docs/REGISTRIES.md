# Préparation des registres MCP

**Rien n'a été soumis.** L'inscription dans un registre et le passage du dépôt en public demandent l'autorisation préalable du
propriétaire. Ce document décrit ce qui est prêt et ce qu'il reste à faire.

## Textes

- **Nom** : AIWorkPay MCP Server
- **FR** : AIWorkPay permet aux agents d'intelligence artificielle de commander des missions réelles à des travailleurs humains, de suivre leur exécution et de récupérer leurs résultats via une API sécurisée.
- **EN** : AIWorkPay enables AI agents to delegate real-world tasks to human workers, track execution, and retrieve verified results through a secure API.
- **Catégories** : agents IA, automatisation, travail humain / crowdsourcing, paiements.
- **Authentification** : clé API `awp_…` en `Authorization: Bearer`, délivrée par un administrateur AIWorkPay (pas d'inscription libre).

## Registre MCP officiel (registry.modelcontextprotocol.io)

- `server.json` est prêt et valide au schéma 2025-12-11 (`test/registry.test.ts`). Description ≤ 100 caractères (limite du registre) ; les textes FR/EN ci-dessus sont pour les fiches.
- Le nom `fr.aiworkpay/mcp-server` exige de prouver la propriété de `aiworkpay.fr` : enregistrement DNS TXT ou fichier HTTP `/.well-known/mcp-registry-auth`.
- Publication : `mcp-publisher login dns --domain aiworkpay.fr …` puis `mcp-publisher publish`. À faire **après autorisation**.

## Smithery

Smithery attend une authentification OAuth pour les serveurs distants ; un serveur à clé statique passe par la configuration `x-from`/`x-to`
(en-tête dérivé de la configuration saisie par l'utilisateur). À valider sur le site de Smithery, inaccessible depuis l'environnement de test.

## Glama

Glama peut indexer un dépôt public (`glama.json`) ou héberger un connecteur. Le dépôt est **privé** : il faudrait d'abord décider de le rendre public.

## Annuaire des connecteurs Claude, ChatGPT

OAuth 2.0 requis (voir `INTEGRATIONS.md`). Hors périmètre tant que le serveur n'a pas OAuth.

## Avant toute soumission

1. Décision du propriétaire : dépôt public ou non, licence (aucune n'est déclarée), adresse de contact.
2. `npm run smoke:remote -- https://mcp.aiworkpay.fr` avec une clé de test, sur le déploiement réel.
3. Politique de confidentialité publiée sur aiworkpay.fr (les registres la demandent) : le serveur ne conserve rien ; les données transitent vers l'API AIWorkPay, qui conserve missions et paiements.
