import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export function hasBinary(bin: string): boolean {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
}

export function ensureForgeArtifacts(): void {
  if (existsSync('out/MockEIP3009.sol/MockEIP3009.json') && existsSync('out/AgentSettleReceipts.sol/AgentSettleReceipts.json')) return;
  const r = spawnSync('forge', ['build'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('forge build failed');
}

export async function startAnvil(port: number): Promise<{ url: string; stop: () => void }> {
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) return { url, stop: () => proc.kill('SIGTERM') };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('anvil did not start');
}

export async function listen(app: Hono): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
