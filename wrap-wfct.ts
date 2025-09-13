#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, BaseError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getNetworkConfig } from './config';
import { getAddresses, mask } from './autotrader/pricing';

dotenv.config();

async function main() {
  const net = getNetworkConfig();
  const rpc = process.env.RPC_URL || net.facetRpcUrl;
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error('PRIVATE_KEY is required in .env');

  // Amount to wrap (FCT -> WFCT). Accept CLI arg (decimal) or env WRAP_AMOUNT_FCT (decimal), default 0.001.
  const arg = process.argv[2];
  const amtStr = arg ?? process.env.WRAP_AMOUNT_FCT ?? '0.001';
  const amount = parseEther(amtStr);

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: net.facetChain, transport: http(rpc) });
  const walletClient = createWalletClient({ chain: net.facetChain, transport: http(rpc), account });

  const { fct: WFCT } = getAddresses(); // TOKEN_FCT env holds WFCT address by convention

  const abi = parseAbi([
    'function deposit() payable',
    'function balanceOf(address) view returns (uint256)'
  ]);

  const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() === 'true';

  // Print context (masked)
  console.log('[WRAP] start', JSON.stringify({ wfct: mask(WFCT), account: mask(account.address), amount_fct: formatEther(amount) }));

  // Show pre-balance
  const before = await publicClient.readContract({ address: WFCT, abi, functionName: 'balanceOf', args: [account.address] }) as bigint;
  console.log('[WRAP] before balance WFCT =', formatEther(before));

  try {
    const { request } = await publicClient.simulateContract({ address: WFCT, abi, functionName: 'deposit', account, value: amount });
    console.log('[SIMULATE] deposit ok');
    if (DRY_RUN) {
      console.log('[WRAP] DRY_RUN: skip sending tx');
      return;
    }
    const hash = await walletClient.writeContract(request);
    console.log('[WRAP] tx sent:', hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('[WRAP] confirmed in block', receipt.blockNumber);
    const after = await publicClient.readContract({ address: WFCT, abi, functionName: 'balanceOf', args: [account.address] }) as bigint;
    console.log('[WRAP] after balance WFCT =', formatEther(after));
  } catch (e) {
    if (e instanceof BaseError) {
      console.error('[ERROR] shortMessage:', e.shortMessage);
      console.error(e.walk());
    } else {
      console.error('[ERROR]', e);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('[ERROR] wrap-wfct fatal', e); process.exit(1); });

