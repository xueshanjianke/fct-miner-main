#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { getAddresses, getPairInfo, getReserves, mask, watchPairPrice, getLatestEthPerFctViaEvents } from './autotrader/pricing';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const showFull = args.includes('--full') || String(process.env.SHOW_FULL).toLowerCase() === 'true';
  const isWatch = args.includes('--watch');
  const lookArg = args.find(a => a.startsWith('--lookback='));
  const lookback = lookArg ? Math.max(0, parseInt(lookArg.split('=')[1] || '1000')) : 1000;
  const use = (a: string) => showFull ? a : mask(a);

  const { pair, router, fct, weth } = getAddresses();

  if (!isWatch) {
    const info = await getPairInfo();
    const r = await getReserves();
    console.log('[PAIR]', JSON.stringify({
      pair: use(pair), router: use(router), fct: use(fct), weth: use(weth),
      token0: use(info.token0), token1: use(info.token1), reserve0: r.reserve0.toString(), reserve1: r.reserve1.toString()
    }));
    // 事件通道最新价格（若可用）
    try {
      const p = await getLatestEthPerFctViaEvents(lookback);
      console.log('[PRICE]', JSON.stringify({ source: p.source, ethPerFctFp18: p.ethPerFctFp18.toString(), slippageBps: p.slippageBps, pair: use(p.ctx.pair), token0: use(p.ctx.token0), token1: use(p.ctx.token1) }));
    } catch {}
    return;
  }

  // --watch 模式：近实时输出价格与滑点
  console.log('[INFO] watch mode on; press Ctrl+C to stop');
  // 先打印一条最新事件/回退价格
  try {
    const p = await getLatestEthPerFctViaEvents(lookback);
    console.log('[PRICE]', JSON.stringify({ source: p.source, ethPerFctFp18: p.ethPerFctFp18.toString(), slippageBps: p.slippageBps, pair: use(p.ctx.pair), token0: use(p.ctx.token0), token1: use(p.ctx.token1) }));
  } catch {}
  // 订阅事件
  const unwatch = await watchPairPrice((u) => {
    try {
      console.log('[TICK]', JSON.stringify({ source: u.source, ethPerFctFp18: u.ethPerFctFp18.toString(), slippageBps: u.slippageBps, pair: use(u.ctx.pair), token0: use(u.ctx.token0), token1: use(u.ctx.token1) }));
    } catch (e) {
      console.error('[WARN] watch handler error', e);
    }
  });
  const cleanup = () => { try { unwatch(); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  // 挂起进程
  await new Promise<void>(() => {});
}

main().catch((e) => { console.error('[ERROR] pair-inspect', e); process.exit(1); });
