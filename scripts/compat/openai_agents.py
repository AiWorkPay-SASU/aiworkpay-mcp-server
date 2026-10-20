import asyncio, json, os
from importlib.metadata import version
from agents.mcp import MCPServerStreamableHttp
async def main():
    async with MCPServerStreamableHttp(name='aiworkpay', params={'url': os.environ['AIW_URL'], 'headers': {'Authorization': 'Bearer ' + os.environ['AIW_KEY']}}, cache_tools_list=True) as server:
        tools = await server.list_tools()
        res = await server.call_tool('get_account', {})
        label = None
        sc = getattr(res, 'structuredContent', None)
        if sc: label = sc['agent']['label']
        else:
            for c in res.content:
                if getattr(c, 'text', None): label = json.loads(c.text)['agent']['label']; break
        print(json.dumps({'framework': 'OpenAI Agents SDK (MCPServerStreamableHttp)', 'version': version('openai-agents'), 'status': 'OK', 'tools': len(tools), 'get_account_label': label}))
asyncio.run(main())
