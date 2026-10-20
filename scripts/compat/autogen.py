import asyncio, json, os
from importlib.metadata import version
from autogen_ext.tools.mcp import StreamableHttpServerParams, mcp_server_tools
async def main():
    params = StreamableHttpServerParams(url=os.environ['AIW_URL'], headers={'Authorization': 'Bearer ' + os.environ['AIW_KEY']})
    tools = await mcp_server_tools(params)
    acct = next(t for t in tools if t.name == 'get_account')
    from autogen_core import CancellationToken
    res = await acct.run_json({}, CancellationToken())
    text = str(res)
    print(json.dumps({'framework': 'AutoGen (autogen-ext[mcp])', 'version': version('autogen-ext'), 'status': 'OK', 'tools': len(tools), 'get_account_label': 'compat-check' if 'compat-check' in text else None}))
asyncio.run(main())
