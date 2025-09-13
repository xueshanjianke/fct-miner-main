#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, BaseError, formatGwei, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getNetworkConfig } from './config';

// Ensure .env values override any machine/session env
dotenv.config({ override: true });

function mask(addr: string) { return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr; }

async function effectiveGasPrice(pc: ReturnType<typeof createPublicClient>): Promise<bigint | undefined> {
  try {
    if (String(process.env.USE_NODE_GAS).toLowerCase() === 'true') return undefined;
    const gp = await pc.getGasPrice();
    const mult = Number(process.env.GAS_PRICE_MULTIPLIER || '1.2');
    let eff = BigInt(Math.floor(Number(gp) * (isFinite(mult) && mult > 0 ? mult : 1)));
    const floorGwei = process.env.GAS_PRICE_FLOOR_GWEI ? parseFloat(process.env.GAS_PRICE_FLOOR_GWEI) : undefined;
    if (floorGwei && isFinite(floorGwei) && floorGwei > 0) {
      const floorWei = parseGwei(String(floorGwei));
      if (eff < floorWei) eff = floorWei;
    }
    return eff;
  } catch { return undefined; }
}

async function main() {
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error('PRIVATE_KEY missing in .env');
  const account = privateKeyToAccount(pk);
  const spender = getAddress(process.env.ROUTER as `0x${string}`);
  const token = getAddress(process.env.TOKEN_FCT as `0x${string}`); // WFCT

  const net = getNetworkConfig();
  const rpc = process.env.FACET_RPC_URL || process.env.RPC_URL || net.facetRpcUrl;
  const pc = createPublicClient({ chain: net.facetChain, transport: http(rpc) });
  const wc = createWalletClient({ chain: net.facetChain, transport: http(rpc), account });

  const ERC20_ABI = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)'
  ]);

  try {
    const MAX = (1n << 256n) - 1n;
    const { request } = await pc.simulateContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX], account: account.address });
    const gasPrice = await effectiveGasPrice(pc);
    if (gasPrice) console.log('[APPROVE] gasPrice=', formatGwei(gasPrice), 'gwei'); else console.log('[APPROVE] gasPrice=node_default');
    const hash = await wc.writeContract({ ...request, account, gasPrice });
    console.log(JSON.stringify({ approve_tx: hash, token: mask(token), spender: mask(spender), owner: mask(account.address) }));

    // 可选等待：WAIT_APPROVE=true 时等待回执（默认不等，立即返回）
    if (String(process.env.WAIT_APPROVE).toLowerCase() === 'true') {
      const waitMs = Number(process.env.APPROVE_WAIT_MS || 300_000);
      console.log(`[APPROVE] waiting up to ${Math.floor(waitMs/1000)}s…`);
      await pc.waitForTransactionReceipt({ hash, timeout: waitMs });
      console.log('[APPROVE] confirmed');
    }
  } catch (e) {
    if (e instanceof BaseError) {
      console.error('[ERROR]', e.shortMessage);
      console.error(e.walk());
    } else {
      console.error('[ERROR]', e);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('[ERROR] approve-only fatal', e); process.exit(1); });
