// A tiny MCP server for live checks: one tool that gives a word.
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result =
    method === 'initialize'
      ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } }
      : method === 'tools/list'
        ? { tools: [{ name: 'word', description: 'Gives the secret word.', inputSchema: { type: 'object', properties: {} } }] }
        : method === 'tools/call'
          ? { content: [{ type: 'text', text: 'The secret word is amber.' }] }
          : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
});
