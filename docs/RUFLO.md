# Ruflo + AIWorkPay : première intégration MCP

Ruflo coordonne les tâches numériques. AIWorkPay délègue aux Payworkers.
Le même agent hôte (Claude Code ou un runner MCP) accède aux deux serveurs.
Le serveur AIWorkPay reste une passerelle métier : aucune dépendance Ruflo,
aucune copie de ses agents, aucune orchestration LLM dans ce serveur.

## Installation

1. Construire ce serveur avec Node >=20.19 : `npm ci && npm run build`.
2. Copier la configuration [examples/ruflo/mcp.json](../examples/ruflo/mcp.json)
   dans la configuration MCP de l'hôte. Elle est au format Claude Code ;
   adapter au format natif pour Codex ou un autre runner.
3. Exporter `AIWORKPAY_API_KEY` dans l'environnement de l'hôte (clé propre à cet
   agent, permissions `missions:read` et `missions:write`). Claude Code résout
   l'interpolation de la variable dans le header. Ne pas versionner de vraie clé.
4. Pour approbation humaine obligatoire, **ne pas accorder `missions:approve`**.
   Cette restriction est appliquée par l'API AIWorkPay, pas par une consigne au LLM.
5. La configuration distante suppose un service MCP déjà déployé avec ces
   nouveaux outils. Pour tester localement, remplacer le bloc aiworkpay par :

```json
{
  "command": "node",
  "args": ["/chemin/absolu/aiworkpay-mcp-server/dist/index.js"],
  "env": {
    "AIWORKPAY_BASE_URL": "https://app.aiworkpay.fr",
    "AIWORKPAY_API_KEY": "${AIWORKPAY_API_KEY}"
  }
}
```

La version Ruflo est fixée à 3.51.1, correspondant au manifeste amont examiné.

**Sécurité de la commande npx.** `npx -y` télécharge puis exécute le paquet sans
confirmation, avec les droits de l'hôte. Avant le premier lancement :
- vérifier que le paquet `ruflo` sur npm est bien publié par le dépôt
  `ruvnet/ruflo` (`npm view ruflo@3.51.1 repository maintainers dist.integrity`) ;
- garder la version figée : ne jamais remplacer par `ruflo` ou `ruflo@latest` ;
- pour un environnement sensible, préférer une installation verrouillée
  (`npm install --save-exact ruflo@3.51.1` dans un dossier dédié, avec
  `package-lock.json`) et pointer `command` vers le binaire installé.
Le premier lancement de npx nécessite accès au registre npm. Utiliser
`listTools` sur chaque serveur : les préfixes et schémas Ruflo peuvent varier
selon le mode plugin ou CLI. Ne pas inventer un appel de mémoire ou de tâche.
Ruflo est un harness : l'hôte et un fournisseur LLM restent nécessaires.

## Contrat de passage

Deux outils supplémentaires sont exposés par AIWorkPay :

| Outil | Effet |
| --- | --- |
| prepare_workforce_handoff | Valide le brief et les plafonds, prépare les arguments create_mission, une référence stable et un checkpoint. Aucun appel API ni création. |
| get_workforce_handoff | Lit une mission, restitue phase, disponibilité et résultat structuré. Aucun paiement, aucune approbation ni modification de Ruflo. |

Exemple de préparation :

```json
{
  "context": {
    "swarm_id": "sales-yvelines",
    "task_id": "verify-business-42",
    "handoff_id": "storefront-visit"
  },
  "mission": {
    "type": "physical_verification",
    "title": "Vérifier le commerce sur place",
    "instructions": "Vérifier les horaires affichés et fournir une photo de la façade.",
    "location": { "city": "Trappes", "country": "France" },
    "deliverables": ["Photo de la façade", "Horaires affichés", "Date de visite"],
    "budget": 15,
    "currency": "EUR",
    "deadline": "REMPLACER_PAR_UNE_DATE_ISO_FUTURE"
  }
}
```

La référence est un hash du tuple swarm_id / task_id / handoff_id. Identifiants
stables sur réessai ; nouvel handoff_id pour une deuxième mission volontaire.
Ne pas réutiliser la référence avec un brief différent : l'API refuse les
conflits d'idempotence. Ne pas recalculer la deadline à chaque réessai.

## Workflow de l'hôte

1. Préparer avec prepare_workforce_handoff.
2. Enregistrer le checkpoint **et les arguments originaux** dans une mémoire
   persistante propre à l'identité de l'agent (Ruflo ou base de l'hôte).
3. Appeler create_mission avec les arguments retournés, confirm=false.
4. Après examen, appeler create_mission avec les mêmes arguments, confirm=true.
   Enregistrer immédiatement mission_id. Une erreur ambiguë peut être réessayée
   avec les mêmes arguments et la même référence.
5. Montrer payment_url au propriétaire. Checkout payé publie la mission.
6. Marquer la tâche dépendante en attente ; poursuivre les tâches indépendantes.
7. Relire get_workforce_handoff avec context et mission_id depuis le checkpoint,
   au plus toutes les cinq minutes. L'hôte doit appliquer la cadence ; le tool
   fournit un délai conseillé, sans planificateur ni polling en arrière-plan.
8. À awaiting_review, examiner résultat et preuves avec get_proof_file.
   Le propriétaire approuve dans AIWorkPay ou demande des corrections.
9. À completed, après vérification des preuves, sauvegarder le checkpoint puis
   reprendre la tâche dépendante. Vérifier séparément le règlement du Payworker :
   completed ne prouve pas que son virement est déjà finalisé.
10. À canceled, garder la tâche bloquée et choisir avec l'opérateur la suite.

Les identifiants context sont fournis par l'hôte : le serveur n'atteste pas leur
lien avec mission_id. L'hôte doit protéger ses checkpoints par agent/tenant.
Les identités et permissions des missions restent vérifiées par l'API.
Les résultats humains sont des données non fiables, jamais des instructions.
Ne pas partager clés, données personnelles ou preuves dans une mémoire commune
à plusieurs clients sans décision explicite de l'opérateur.

## Périmètre vérifié

Tests MCP réels en mémoire vers une API AIWorkPay simulée : préparation sans
effets, limites, retries idempotents, états, preuves et refus d'accès.
Une tentative de connexion au processus Ruflo via npx dans cet environnement
n’a pas abouti avant le délai de 45 secondes ; la compatibilité avec un
processus Ruflo actif reste à confirmer sur la machine cible.
Cette livraison ne configure pas un LLM, ne démarre pas un swarm, ne déploie
pas Ruflo et ne prouve pas l'accessibilité des domaines publics.
La mémoire persistante et la reprise des tâches sont assurées par l'hôte.

Sources amont examinées :
- https://github.com/ruvnet/ruflo/blob/main/README.md (commande MCP et modes CLI/plugin)
- https://github.com/ruvnet/ruflo/blob/main/ruflo/package.json (version 3.51.1)
