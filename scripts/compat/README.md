# Vérification des frameworks d'agents

Chaque script se connecte au serveur MCP en HTTP avec une clé, liste les outils et appelle `get_account`, puis affiche une ligne JSON.
Un environnement virtuel par framework (voir `docs/INTEGRATIONS.md` pour les paquets et versions) :

```bash
AIW_URL=http://127.0.0.1:3399/mcp AIW_KEY=awp_… python scripts/compat/openai_agents.py
```

Ne lancez ces scripts que contre une instance de test : `get_account` est en lecture seule, mais la clé reste une clé réelle.
