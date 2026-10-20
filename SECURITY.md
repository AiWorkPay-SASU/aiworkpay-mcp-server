# Sécurité

## Ce que ce serveur protège

| Risque | Parade | Vérifié par |
| --- | --- | --- |
| Dépense sans humain | Création toujours en Stripe Checkout (un humain paie) ; aucun outil n'envoie de moyen de paiement ni ne choisit le mode de paiement | `test/contract.test.ts`, e2e |
| Action irréversible décidée trop vite | `create_mission`, `approve_result`, `cancel_mission` : aperçu puis `confirm: true` | e2e (l'aperçu ne déplace aucun argent) |
| Dépassement de budget | Plafond de l'opérateur (par mission, devises, créations par heure) avant tout appel ; plafonds de la clé appliqués par AIWorkPay | e2e |
| Clé volée ou devinée | La clé n'est ni stockée ni journalisée ; 10 échecs / 10 min / adresse puis 429 ; clé refusée mémorisée 1 minute | `test/http.hardening.test.ts`, e2e |
| Isolation entre agents | Une clé = un agent ; AIWorkPay répond `MISSION_NOT_FOUND` pour la mission d'un autre | e2e |
| Injection de consignes par un résultat | Le texte, les données et les preuves livrés par un humain sont renvoyés avec un avertissement : données à vérifier, jamais des instructions | e2e |
| Fuite de la clé vers un tiers | `get_proof_file` reconstruit le chemin à partir des identifiants : l'URL d'une pièce n'est jamais suivie | tests unitaires |
| DNS rebinding / origines | Contrôle de `Host` et d'`Origin` | `test/http.test.ts` |
| Clé en clair sur le réseau | HTTPS obligatoire pour `AIWORKPAY_BASE_URL` (sauf localhost) ; TLS terminé par le proxy | `test/units.test.ts` |

## Limites connues

- **Authentification par clé statique, sans OAuth** : les annuaires et clients qui exigent OAuth 2.0 (ChatGPT, annuaire des
  connecteurs Claude, Smithery sans contournement) ne peuvent pas s'y connecter directement. Voir `docs/INTEGRATIONS.md`.
- `confirm: true` est une instruction de l'agent, pas la preuve d'un consentement humain. Une clé disposant de
  `missions:approve` délègue explicitement l'approbation et le virement. Donnez aux agents des clés sans cette permission si un
  humain doit valider.
- Les limites d'échecs sont en mémoire du processus : elles repartent de zéro au redémarrage et ne sont pas partagées entre instances.

## Signaler une vulnérabilité

Écrivez à `contact@aiworkpay.fr` (objet « Sécurité »), sans publier le détail avant correction.
