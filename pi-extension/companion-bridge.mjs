import { Type } from '@earendil-works/pi-ai';

export default function (pi) {
  let request;
  pi.on('session_start', async () => {
    const url = process.env.COMPANION_BRIDGE_URL;
    const token = process.env.COMPANION_BRIDGE_TOKEN;
    request = async (path, body, signal) => {
      const response = await fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
      if (!response.ok) throw new Error('Companion bridge rejected request');
      return response.json();
    };
    const manifest = await request('/manifest');
    for (const tool of manifest) pi.registerTool({ name: tool.name, label: tool.name,
      description: tool.description, parameters: Type.Unsafe(tool.parameters),
      async execute(id, params, signal) {
        const result = await request('/tool', { name: tool.name, args: params, toolCallId: id }, signal);
        return { content: result.content, details: result.details };
      } });
    const tools = pi.getActiveTools();
    const matches = JSON.stringify([...tools].sort()) === JSON.stringify(manifest.map(t => t.name).sort());
    await request('/report', { kind: matches ? 'ready' : 'tools_mismatch', tools });
  });
  pi.on('before_agent_start', async () => ({ systemPrompt: (await request('/run')).systemPrompt }));
}
