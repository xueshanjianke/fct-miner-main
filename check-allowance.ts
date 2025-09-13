#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getNetworkConfig } from './config';

// Ensure .env values override any machine/session env
dotenv.config({ override: true });

function mask(addr: string) { return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr; }

async function main() {
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error('PRIVATE_KEY missing in .env');
  const owner = privateKeyToAccount(pk).address;
  const spender = getAddress(process.env.ROUTER as `0x${string}`);
  const token = getAddress(process.env.TOKEN_FCT as `0x${string}`); // WFCT

  const net = getNetworkConfig();
  // Prefer explicit Facet RPC from .env, then generic RPC_URL, then default
  const rpc = process.env.FACET_RPC_URL || process.env.RPC_URL || net.facetRpcUrl;
  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });

  const ERC20_ABI = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)'
  ]);

  const [allowance, balance] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }) as Promise<bigint>,
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
  ]);

  console.log(JSON.stringify({
    owner: mask(owner),
    spender: mask(spender),
    token: mask(token),
    allowance: allowance.toString(),
    balance: balance.toString(),
  }));
}

main().catch((e) => { console.error('[ERROR] check-allowance', e); process.exit(1); });
