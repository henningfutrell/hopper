// Issue #1958: the MCP server double answers MCP's Streamable HTTP transport as a real server does, and keeps each tool
// call in memory for the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ECHO_TOOL, startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.ts';

let mcp: FakeMcpServer;
beforeAll(async () => { mcp = await startFakeMcpServer(); });
afterAll(async () => { await mcp.close(); });

const rpc = async (body: Record<string, unknown>): Promise<Response> => fetch(mcp.url, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }),
});

describe('the MCP server double', () => {
  it('initializes with the protocol version the client asked for, takes a notification with 202, and lists its tool', async () => {
    expect(await (await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json())
      .toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'double', version: '1.0.0' } } });
    expect((await rpc({ method: 'notifications/initialized' })).status).toBe(202);
    expect(await (await rpc({ id: 2, method: 'tools/list' })).json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [ECHO_TOOL] } });
  });

  it('answers a tool call and keeps it; an unknown tool is a tool error, an unknown method a JSON-RPC error', async () => {
    expect(await (await rpc({ id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })).json())
      .toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'echo: hi' }] } });
    expect(await (await rpc({ id: 4, method: 'tools/call', params: { name: 'other', arguments: {} } })).json())
      .toMatchObject({ result: { isError: true } });
    expect(await (await rpc({ id: 5, method: 'resources/list' })).json()).toMatchObject({ error: { code: -32601 } });
    expect(mcp.calls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }, { name: 'other', arguments: {} }]);
    expect(mcp.methods).toContain('tools/call');
  });

  it('opens no event stream', async () => {
    expect((await fetch(mcp.url)).status).toBe(405);
  });
});
