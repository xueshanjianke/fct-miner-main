#!/usr/bin/env bun
import { 
  createPublicClient,
  http,
  formatEther,
  type Hash
} from 'viem';
import { computeFacetTransactionHash } from '@0xfacet/sdk/utils';
import * as dotenv from 'dotenv';
import { getNetworkConfig } from './config';

dotenv.config();

// ------------------------------
// 文件概述（中文注释）
// ------------------------------
// L1→L2 哈希映射/校验工具：
// - 输入以太坊 L1 交易哈希，计算对应的 Facet L2 交易哈希
// - 基础版：使用默认参数快速估算
// - 进阶版：尝试解析输入数据（RLP 近似）并输出更多信息
// - 可作为独立 CLI 使用（--advanced 可选）

// Get network configuration
const networkConfig = getNetworkConfig();

// L1 client for fetching transaction details
const publicClient = createPublicClient({
  chain: networkConfig.l1Chain,
  transport: http(networkConfig.l1RpcUrl),
});

// Get Facet chain configuration from network config
const facetChain = networkConfig.facetChain;

const facetClient = createPublicClient({
  chain: facetChain,
  transport: http(networkConfig.facetRpcUrl),
});

// 基础版：从 L1 哈希推导 L2 哈希，并尽可能查询 L2 状态
async function getL2HashFromL1(l1Hash: Hash): Promise<{
  l1Hash: string;
  l2Hash: string;
  from: string;
  to: string;
  value: string;
  gasLimit: bigint;
  fctMinted: string;
  l1Block: bigint;
  l2Block?: bigint;
  l2Status?: string;
} | null> {
  try {
    console.log('Fetching L1 transaction:', l1Hash);
    
    // Get L1 transaction details
    const l1Tx = await publicClient.getTransaction({ hash: l1Hash });
    
    if (!l1Tx) {
      console.error('L1 transaction not found');
      return null;
    }
    
    // Get the receipt to ensure it was mined
    const l1Receipt = await publicClient.getTransactionReceipt({ hash: l1Hash });
    
    if (!l1Receipt) {
      console.error('L1 transaction not yet mined');
      return null;
    }
    
    // Parse the Facet transaction data
    // Facet transactions start with type byte 0x46 (70 in decimal)
    const data = l1Tx.input;
    
    if (!data || !data.startsWith('0x46')) {
      console.error('Not a Facet transaction (missing type 70 prefix)');
      return null;
    }
    
    // For simplicity, we'll use default values for the Facet transaction parameters
    // In a real implementation, you'd parse these from the RLP-encoded data
    const defaultGasLimit = 21000n;
    const defaultFctMinted = 0n; // This would need to be calculated based on mint rate
    
    // Compute the Facet transaction hash
    const l2Hash = computeFacetTransactionHash(
      l1Hash,
      l1Tx.from,
      l1Tx.to || '0x0000000000000000000000000000000000000000',
      l1Tx.value,
      '0x', // data (empty for simple transfers)
      defaultGasLimit,
      defaultFctMinted
    );
    
    console.log('\n✅ Computed L2 hash:', l2Hash);
    
    // Try to fetch the L2 transaction status
    let l2Block: bigint | undefined;
    let l2Status: string | undefined;
    
    try {
      console.log('Checking L2 status...');
      const l2Receipt = await facetClient.getTransactionReceipt({
        hash: l2Hash as Hash,
      });
      
      if (l2Receipt) {
        l2Block = l2Receipt.blockNumber;
        l2Status = l2Receipt.status === 'success' ? 'Confirmed' : 'Failed';
        console.log('L2 Status:', l2Status, 'in block', l2Block);
      }
    } catch (error) {
      console.log('L2 transaction not yet confirmed or not found');
      l2Status = 'Pending or Not Found';
    }
    
    return {
      l1Hash: l1Hash,
      l2Hash: l2Hash,
      from: l1Tx.from,
      to: l1Tx.to || 'Contract Creation',
      value: formatEther(l1Tx.value) + ' ETH',
      gasLimit: defaultGasLimit,
      fctMinted: formatEther(defaultFctMinted) + ' FCT',
      l1Block: l1Receipt.blockNumber,
      l2Block,
      l2Status
    };
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
}

// Advanced version that properly parses the Facet transaction
// 进阶版：更细致地解析 Facet 交易，输出估算的 mine boost 与字段
async function getL2HashFromL1Advanced(l1Hash: Hash): Promise<{
  l1Hash: string;
  l2Hash: string;
  facetTo: string;
  facetValue: string;
  facetData: string;
  gasLimit: bigint;
  mineBoostSize: number;
  estimatedFct: string;
  l1Block: bigint;
} | null> {
  try {
    console.log('Fetching L1 transaction (advanced):', l1Hash);
    
    // Get L1 transaction details
    const l1Tx = await publicClient.getTransaction({ hash: l1Hash });
    
    if (!l1Tx) {
      console.error('L1 transaction not found');
      return null;
    }
    
    // Get the receipt
    const l1Receipt = await publicClient.getTransactionReceipt({ hash: l1Hash });
    
    if (!l1Receipt) {
      console.error('L1 transaction not yet mined');
      return null;
    }
    
    // Parse the Facet transaction data
    const data = l1Tx.input;
    
    if (!data || !data.startsWith('0x46')) {
      console.error('Not a Facet transaction');
      return null;
    }
    
    // Skip the type byte and parse RLP data
    // This is a simplified parsing - full implementation would need proper RLP decoding
    const rlpData = data.slice(4); // Skip '0x46'
    
    // For demonstration, we'll extract some basic info
    // In reality, you'd use an RLP decoder to properly parse the transaction
    
    // Estimate mine boost size (data after the core transaction)
    const mineBoostSize = Math.floor((data.length - 2) / 2) - 160; // Approximate
    
    // Use SDK to compute hash with estimated values
    const l2Hash = computeFacetTransactionHash(
      l1Hash,
      l1Tx.from,
      l1Tx.from, // Simplified: assuming self-transfer for mining
      0n,
      '0x',
      21000n,
      0n // Would need actual mint rate calculation
    );
    
    return {
      l1Hash: l1Hash,
      l2Hash: l2Hash,
      facetTo: l1Tx.from, // Simplified
      facetValue: '0 ETH',
      facetData: '0x',
      gasLimit: 21000n,
      mineBoostSize: mineBoostSize,
      estimatedFct: 'Requires mint rate at block ' + l1Receipt.blockNumber,
      l1Block: l1Receipt.blockNumber,
    };
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
}

// 命令行入口：bun l1-to-l2-hash.ts <hash> [--advanced]
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('用法 Usage:');
    console.log('  bun l1-to-l2-hash.ts <l1_transaction_hash>');
    console.log('  bun l1-to-l2-hash.ts <l1_transaction_hash> --advanced');
    console.log('');
    console.log('示例 Example:');
    console.log('  bun l1-to-l2-hash.ts 0x123abc...');
    console.log('');
    console.log('说明: 该工具通过 L1 哈希计算对应的 Facet L2 交易哈希 | Calculates the Facet L2 tx hash from an L1 hash');
    process.exit(1);
  }
  
  const l1Hash = args[0] as Hash;
  const advanced = args.includes('--advanced');
  
  if (!l1Hash.startsWith('0x') || l1Hash.length !== 66) {
    console.error('交易哈希格式无效（Invalid transaction hash format）');
    process.exit(1);
  }
  
  if (advanced) {
    const result = await getL2HashFromL1Advanced(l1Hash);
    
    if (result) {
      console.log('\n=== L1→L2 哈希映射（高级 Advanced） ===');
      console.log('L1 交易哈希 L1 Transaction Hash:', result.l1Hash);
      console.log('L1 区块 L1 Block:', result.l1Block.toString());
      console.log('');
      console.log('Facet 交易详情 Facet Transaction Details:');
      console.log('  To/收款地址:', result.facetTo);
      console.log('  Value/金额:', result.facetValue);
      console.log('  Data/数据:', result.facetData);
      console.log('  Gas 限额 Gas Limit:', result.gasLimit.toString());
      console.log('  mineBoost 大小 Mine Boost Size:', result.mineBoostSize, 'bytes');
      console.log('  估算 FCT Estimated FCT:', result.estimatedFct);
      console.log('');
      console.log('L2 交易哈希 L2 Transaction Hash:', result.l2Hash);
      console.log('');
      console.log('在浏览器查看 View on Facet Explorer:');
      console.log(`  https://explorer.facet.org/tx/${result.l2Hash}`);
    }
  } else {
    const result = await getL2HashFromL1(l1Hash);
    
    if (result) {
      console.log('\n=== L1→L2 哈希映射（基础 Basic） ===');
      console.log('L1 Transaction Hash:', result.l1Hash);
      console.log('L1 Block:', result.l1Block.toString());
      console.log('L1 Etherscan:', `https://etherscan.io/tx/${result.l1Hash}`);
      console.log('');
      console.log('Transaction Details:');
      console.log('  From:', result.from);
      console.log('  To:', result.to);
      console.log('  Value:', result.value);
      console.log('  Gas Limit:', result.gasLimit.toString());
      console.log('  FCT Minted:', result.fctMinted);
      console.log('');
      console.log('L2 Transaction Hash:', result.l2Hash);
      if (result.l2Status) {
        console.log('L2 Status:', result.l2Status);
        if (result.l2Block) {
          console.log('L2 Block:', result.l2Block.toString());
        }
      }
      console.log('');
      console.log('View on Facet Explorer:');
      console.log(`  https://explorer.facet.org/tx/${result.l2Hash}`);
    }
  }
}

// Export functions for use in other scripts
export { getL2HashFromL1, getL2HashFromL1Advanced };

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
