import json, os
from importlib.metadata import version
from crewai_tools import MCPServerAdapter
params = {'url': os.environ['AIW_URL'], 'transport': 'streamable-http', 'headers': {'Authorization': 'Bearer ' + os.environ['AIW_KEY']}}
with MCPServerAdapter(params) as tools:
    names = [t.name for t in tools]
    acct = next(t for t in tools if t.name == 'get_account')
    out = acct.run()
    print(json.dumps({'framework': 'CrewAI (crewai-tools MCPServerAdapter)', 'version': version('crewai-tools'), 'status': 'OK', 'tools': len(names), 'get_account_label': 'compat-check' if 'compat-check' in str(out) else None}))
