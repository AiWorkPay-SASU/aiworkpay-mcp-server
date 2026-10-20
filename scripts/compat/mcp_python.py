import asyncio, json, os
from importlib.metadata import version
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client, create_mcp_http_client
async def main():
    http = create_mcp_http_client(headers={'Authorization': 'Bearer ' + os.environ['AIW_KEY']})
    async with http:
        async with streamable_http_client(os.environ['AIW_URL'], http_client=http) as streams:
            r, w = streams[0], streams[1]
            async with ClientSession(r, w) as s:
                await s.initialize()
                tools = [t.name for t in (await s.list_tools()).tools]
                res = await s.call_tool('get_account', {})
                sc = res.structured_content if hasattr(res, 'structured_content') else getattr(res, 'structuredContent', None)
                print(json.dumps({'framework': 'mcp (SDK Python officiel)', 'version': version('mcp'), 'status': 'OK', 'tools': len(tools), 'get_account_label': sc['agent']['label'] if sc else None}))
asyncio.run(main())
