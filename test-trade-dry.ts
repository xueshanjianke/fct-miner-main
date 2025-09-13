#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { readLedger } from './src/autotrader/ledger';
import { getSpotEthPerFctFp18, getAddresses } from './autotrader/pricing';
import { BaseError, parseAbi, createPublicClient, http } from 'viem';
import { getNetworkConfig } from './config';

dotenv.config();

const V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)'
]);

function bps(n: number) { return Math.max(0, Math.min(10_000, Math.floor(n))); }

async function main() {
  const ledgerPath = process.env.LEDGER_PATH || './autotrader-ledger.json';
  const ledger = readLedger(ledgerPath);
  const inv = BigInt(ledger.inventoryFCT);
  const wac = BigInt(ledger.wacEthPerFCT); // fp18

  const SLIPPAGE_BPS = bps(Number(process.env.SLIPPAGE_BPS ?? '100'));
  const MIN_TRADE_FCT = BigInt(process.env.MIN_TRADE_FCT ?? '1000000000000000000');
  const CHUNK_PCT = Math.max(0, Math.min(1, Number(process.env.CHUNK_PCT ?? '0.2')));

  let px = 0n;
  let source = 'pair';
  try {
    const override = process.env.PRICE_OVERRIDE;
    if (override && override.trim() !== '') {
      const f = Number(override);
      if (Number.isFinite(f) && f > 0) {
        px = BigInt(Math.floor(f * 1e18));
        source = 'override';
      }
    }
  } catch {}
  if (px === 0n) {
    try {
      const r = await getSpotEthPerFctFp18();
      px = r.priceFp18;
      source = 'pair';
    } catch (e) {
      source = 'error';
    }
  }

  const hitTp = (inv > 0n) && (px >= (wac * BigInt(Math.floor((1 + Number(process.env.TAKE_PROFIT ?? '0.12')) * 1e6))) / 1_000_000n);
  const amtByPct = (inv * BigInt(Math.floor(CHUNK_PCT * 1e6))) / 1_000_000n;
  const amountIn = inv === 0n ? 0n : (amtByPct > MIN_TRADE_FCT ? amtByPct : MIN_TRADE_FCT);

  // Only initialize DEX context if all addresses are provided via .env
  const haveDexEnv = !!(process.env.ROUTER && process.env.PAIR && process.env.TOKEN_FCT && process.env.TOKEN_WETH);
  let fct: `0x${string}` | undefined;
  let weth: `0x${string}` | undefined;
  let router: `0x${string}` | undefined;
  let publicClient: ReturnType<typeof createPublicClient> | undefined;
  if (haveDexEnv) {
    const addrs = getAddresses();
    fct = addrs.fct; weth = addrs.weth; router = addrs.router;
    const net = getNetworkConfig();
    const rpc = process.env.RPC_URL || net.facetRpcUrl;
    publicClient = createPublicClient({ chain: net.facetChain, transport: http(rpc) });
  }

  // Compute minOut via router quote
  let minOut = 0n;
  let allowance = '0';
  let balance = '0';
  if (publicClient && fct && weth && router) {
    try {
      const res = (await publicClient.readContract({ address: router, abi: V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, [fct, weth]] })) as bigint[];
      const est = res?.[res.length - 1] ?? 0n;
      minOut = est > 0n ? (est * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
    } catch (e) {}
  }
  try {
    const erc20 = parseAbi(['function balanceOf(address owner) view returns (uint256)','function allowance(address owner,address spender) view returns (uint256)']);
    // Optional: owner address from PRIVATE_KEY if provided; else omit balance/allowance (remain '0')
    const owner = process.env.PRIVATE_KEY ? undefined : undefined;
    // No-op; leave as '0' when owner unknown in dry-run
  } catch {}

  const line = {
    px: px.toString(),
    wac: wac.toString(),
    hit_tp: hitTp,
    reason: inv === 0n ? 'no_inventory' : (px === 0n ? 'no_price' : (hitTp ? 'tp_met' : 'below_tp')),
    amount_in: amountIn.toString(),
    min_out: minOut.toString(),
    allowance,
    balance,
  };
  console.log(JSON.stringify(line));
}

// 在 Node/tsx 环境中，import.meta.main 在 Node 并非标准属性。
// 这里直接调用 main() 以保证通过脚本执行时能输出结果。
main().catch((e) => {
  if (e instanceof BaseError) {
    console.error('[ERROR]', e.shortMessage);
    console.error(e.walk());
  } else {
    console.error('[ERROR]', e);
  }
  process.exit(1);
});
