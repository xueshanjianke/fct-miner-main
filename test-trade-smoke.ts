#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { getAddresses, mask, getReserves } from './autotrader/pricing';
import { ensureApproveIfNeeded, getClients } from './autotrader/swap';
import { BaseError, parseAbi, getAddress } from 'viem';

// Ensure .env values take precedence over machine-level env
dotenv.config({ override: true });

const V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)'
]);
const V2_ROUTER_VIEW_ABI = parseAbi([
  'function WETH() view returns (address)'
]);
const WETH_FN_CANDIDATES = [
  'function WETH() view returns (address)',
  'function WETH9() view returns (address)',
  'function weth() view returns (address)',
  'function WRAPPED_ETH() view returns (address)'
] as const;

function bps(n: number) { return Math.max(0, Math.min(10_000, Math.floor(n))); }

async function main() {
  if ((process.env.NETWORK || '').toLowerCase() !== 'mainnet') {
    console.warn('[WARN] 非主网环境（NETWORK != mainnet）。建议使用: pnpm test:trade:smoke  | Not on mainnet; use: pnpm test:trade:smoke');
  }
  const SLIPPAGE_BPS = bps(Number(process.env.SLIPPAGE_BPS ?? '3000'));
  const AMT = BigInt(process.env.SMOKE_AMOUNT_FCT ?? '1000000000000000');
  const { router, fct, weth } = getAddresses();
  const { publicClient, walletClient, account, localAccount } = getClients();
  // Use router's canonical WETH for path to satisfy router checks
  let routerWeth = (process.env.ROUTER_WETH as `0x${string}` | undefined) ? getAddress(process.env.ROUTER_WETH as `0x${string}`) : weth;
  for (const sig of WETH_FN_CANDIDATES) {
    try {
      const abi = parseAbi([sig]);
      const fn = (sig.match(/function\s+(\w+)/)?.[1] || 'WETH') as any;
      const res = await publicClient.readContract({ address: router, abi, functionName: fn });
      if (typeof res === 'string' && res) { routerWeth = getAddress(res as `0x${string}`); break; }
    } catch {}
  }
  if (!routerWeth || routerWeth.toLowerCase() === weth.toLowerCase()) {
    // EIP-1967 impl fallback
    try {
      const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const raw = await publicClient.getStorageAt({ address: router, slot: IMPL_SLOT });
      if (typeof raw === 'string' && raw.length >= 66) {
        const impl = getAddress(('0x' + raw.slice(-40)) as `0x${string}`);
        for (const sig of WETH_FN_CANDIDATES) {
          try {
            const abi = parseAbi([sig]);
            const fn = (sig.match(/function\s+(\w+)/)?.[1] || 'WETH') as any;
            const res = await publicClient.readContract({ address: impl, abi, functionName: fn });
            if (typeof res === 'string' && res) { routerWeth = getAddress(res as `0x${string}`); break; }
          } catch {}
        }
      }
    } catch {}
  }
  if (routerWeth.toLowerCase() !== weth.toLowerCase()) {
    console.warn('[WARN] TOKEN_WETH (.env) 与 router.WETH() 不一致，路径将使用 router.WETH()。env=', mask(weth), 'router=', mask(routerWeth), '| TOKEN_WETH (.env) != router.WETH(); using router.WETH() for path.');
  }

  // Quote and compute minOut
  let outEst: bigint = 0n;
  try {
    const amounts = (await publicClient.readContract({ address: router, abi: V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [AMT, [fct, routerWeth]] })) as bigint[];
    outEst = amounts[amounts.length - 1] ?? 0n;
  } catch (e) {
    // Router quote failed (e.g., factory mismatch or no reserves). Fallback: estimate via Pair reserves.
    const r = await getReserves();
    const is0Fct = r.token0.toLowerCase() === fct.toLowerCase();
    const reserveIn = is0Fct ? r.reserve0 : r.reserve1;
    const reserveOut = is0Fct ? r.reserve1 : r.reserve0;
    const amtWithFee = AMT * 997n;
    outEst = (amtWithFee * reserveOut) / (reserveIn * 1000n + amtWithFee);
    console.log('[PRICE]', JSON.stringify({ source: 'pair_fallback', token0: mask(r.token0), token1: mask(r.token1), reserve0: r.reserve0.toString(), reserve1: r.reserve1.toString(), out_est: outEst.toString() }));
  }
  const minOut = outEst > 0n ? (outEst * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);

  console.log('[APPROVE] ensuring max approval');
  await ensureApproveIfNeeded(AMT, false);

  // ---- debug: print path context before simulate ----
  try {
    const routerWethOnChain = routerWeth; // already resolved via override/view/impl
    console.log('[DEBUG] ROUTER_WETH (env override):', process.env.ROUTER_WETH || '(none)');
    console.log('[DEBUG] routerWeth used            :', routerWethOnChain);
    console.log('[DEBUG] TOKEN_FCT (env)            :', process.env.TOKEN_FCT);
    console.log('[DEBUG] path actually used         :', [fct, routerWethOnChain]);
  } catch {}
  // ---- end debug ----

  try {
    const { request } = await publicClient.simulateContract({
      address: router,
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [AMT, minOut, [fct, routerWeth], account, deadline],
      account,
    });
    const gasEst = await publicClient.estimateContractGas({
      address: router,
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
      args: [AMT, minOut, [fct, routerWeth], account, deadline],
      account,
    });
    // Use boosted gasPrice if configured; allow node default via USE_NODE_GAS=true
    let gasPrice: bigint | undefined;
    try {
      if (String(process.env.USE_NODE_GAS).toLowerCase() !== 'true') {
        const gp = await publicClient.getGasPrice();
        const mult = Number(process.env.GAS_PRICE_MULTIPLIER || '1.2');
        gasPrice = BigInt(Math.floor(Number(gp) * (isFinite(mult) && mult > 0 ? mult : 1)));
      }
    } catch {}
    const tx = await walletClient.writeContract({ ...request, account: localAccount, gasPrice });
    console.log(JSON.stringify({ tx_hash: tx, gas_used_est: gasEst.toString(), path: [mask(fct), mask(routerWeth)], amount_in: AMT.toString(), amount_out_min: minOut.toString() }));
  } catch (e) {
    if (e instanceof BaseError) {
      console.error('[ERROR] 错误摘要（shortMessage）:', e.shortMessage);
      console.error(e.walk());
    } else {
      console.error('[ERROR] 烟囱交易失败（smoke failed）:', e);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('[ERROR] 致命错误（test:trade:smoke fatal）', e); process.exit(1); });
