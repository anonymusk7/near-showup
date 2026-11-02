// Live dry quote (no funds, no JWT): 1 USDC on Base -> USDC on NEAR to the given recipient.
import { getQuote } from '../lib/oneclick.mjs';
const q = await getQuote({ originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amount: '1000000', recipient: process.argv[2] || 'anonymusk.near', refundTo: '0x0000000000000000000000000000000000000001', dry: true });
console.log(JSON.stringify(q, null, 2));
