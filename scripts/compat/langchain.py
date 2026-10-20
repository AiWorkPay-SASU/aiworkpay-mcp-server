import asyncio, json, os
from importlib.metadata import version
from langchain_mcp_adapters.client import MultiServerMCPClient
async def main():
    client = MultiServerMCPClient({'aiworkpay': {'transport': 'streamable_http', 'url': os.environ['AIW_URL'], 'headers': {'Authorization': 'Bearer ' + os.environ['AIW_KEY']}}})
    tools = await client.get_tools()
    acct = next(t for t in tools if t.name == 'get_account')
    out = await acct.ainvoke({})
    text = out if isinstance(out, str) else json.dumps(out) if not isinstance(out, list) else ' '.join(str(x.get('text', x)) if isinstance(x, dict) else str(x) for x in out)
    label = 'compat-check' if 'compat-check' in text else None
    print(json.dumps({'framework': 'LangChain / LangGraph (langchain-mcp-adapters)', 'version': version('langchain-mcp-adapters') + ' + langgraph ' + version('langgraph'), 'status': 'OK', 'tools': len(tools), 'get_account_label': label}))
asyncio.run(main())
