/**
 * TROLLER BURN BOT v3.0
 * ----------------------
 * Uses Helius Jupiter Swap API (no external DNS needed)
 * → Monitors wallet for incoming SOL
 * → Buys $TROLLER via Helius/Jupiter
 * → Burns $TROLLER on-chain automatically
 */

require('dotenv').config();
const {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  createBurnInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const axios = require('axios');
const bs58 = require('bs58');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TROLLER_MINT     = 'DDSnK25736sBknvGncjW43sxbWqHa155AihgBH4Npump';
const BURN_PERCENT     = 0.99;
const GAS_RESERVE      = 0.01;
const POLL_INTERVAL_MS = 5000;
const MIN_SOL_TRIGGER  = 0.005;

const RPC_URL = process.env.HELIUS_RPC;
if (!RPC_URL) { console.error('HELIUS_RPC not set in .env'); process.exit(1); }

// Extract API key from Helius RPC URL
const HELIUS_API_KEY = RPC_URL.match(/api-key=([^&]+)/)?.[1];
if (!HELIUS_API_KEY) { console.error('Could not extract Helius API key from RPC URL'); process.exit(1); }

const WALLET_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEY)
);

// ─── SETUP ────────────────────────────────────────────────────────────────────

const connection  = new Connection(RPC_URL, 'confirmed');
const trollerMint = new PublicKey(TROLLER_MINT);

let lastKnownBalance    = 0;
let processedSignatures = new Set();
let isProcessing        = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── SWAP: SOL → $TROLLER via Helius Jupiter API ──────────────────────────────

async function swapSolForTroller(solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  log(`Swapping ${solAmount.toFixed(4)} SOL → $TROLLER via Helius...`);

  // Helius Jupiter Quote endpoint
  const quoteUrl =
    `https://mainnet.helius-rpc.com/v0/quote` +
    `?api-key=${HELIUS_API_KEY}` +
    `&inputMint=So11111111111111111111111111111111111111112` +
    `&outputMint=${TROLLER_MINT}` +
    `&amount=${lamports}` +
    `&slippageBps=500`;

  let quote;
  try {
    const { data } = await axios.get(quoteUrl, { timeout: 15000 });
    quote = data;
  } catch (err) {
    // Fallback: try Helius swap directly via RPC sendTransaction with Jupiter serialized tx
    throw new Error(`Helius quote failed: ${err.message}`);
  }

  if (!quote?.outAmount) {
    throw new Error('No quote returned: ' + JSON.stringify(quote));
  }

  log(`Quote: ${lamports} lamports → ${Number(quote.outAmount).toLocaleString()} $TROLLER`);

  // Helius Jupiter Swap endpoint
  const { data: swapData } = await axios.post(
    `https://mainnet.helius-rpc.com/v0/swap?api-key=${HELIUS_API_KEY}`,
    {
      quoteResponse: quote,
      userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
    { timeout: 15000 }
  );

  if (!swapData?.swapTransaction) {
    throw new Error('No swap transaction: ' + JSON.stringify(swapData));
  }

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapData.swapTransaction, 'base64')
  );
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
    skipPreflight: true,
  });

  log(`Swap TX sent: ${sig}`);
  await connection.confirmTransaction(sig, 'confirmed');
  log(`✅ Swap confirmed → https://solscan.io/tx/${sig}`);

  return BigInt(quote.outAmount);
}

// ─── BURN $TROLLER ─────────────────────────────────────────────────────────────

async function burnTroller(amount) {
  log(`Burning ${amount.toLocaleString()} $TROLLER...`);

  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    WALLET_KEYPAIR,
    trollerMint,
    WALLET_KEYPAIR.publicKey
  );

  const { value } = await connection.getTokenAccountBalance(tokenAccount.address);
  const available = BigInt(value.amount);
  if (available < amount) amount = available;
  if (amount === 0n) { log('No $TROLLER to burn.'); return; }

  const burnIx = createBurnInstruction(
    tokenAccount.address,
    trollerMint,
    WALLET_KEYPAIR.publicKey,
    amount,
    [],
    TOKEN_PROGRAM_ID
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: WALLET_KEYPAIR.publicKey,
    recentBlockhash: blockhash,
    instructions: [burnIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  const uiAmount = (Number(amount) / Math.pow(10, value.decimals)).toLocaleString();
  log(`🔥 BURNED ${uiAmount} $TROLLER → https://solscan.io/tx/${sig}`);
}

// ─── PROCESS INCOMING SOL ─────────────────────────────────────────────────────

async function processIncomingSOL(diffLamports, sig) {
  if (isProcessing) return;
  isProcessing = true;

  const incomingSOL = diffLamports / LAMPORTS_PER_SOL;
  const solToBurn   = incomingSOL * BURN_PERCENT;

  log(`\n💰 +${incomingSOL.toFixed(4)} SOL received (TX: ${sig})`);
  log(`→ Using ${solToBurn.toFixed(4)} SOL (99%) to buy & burn $TROLLER`);

  if (solToBurn < MIN_SOL_TRIGGER) {
    log(`Amount too small (${solToBurn} SOL), skipping.`);
    isProcessing = false;
    return;
  }

  try {
    const trollerAmount = await swapSolForTroller(solToBurn);
    await burnTroller(trollerAmount);
    log(`✅ Complete: ${incomingSOL.toFixed(4)} SOL → $TROLLER → BURNED\n`);
  } catch (err) {
    log(`❌ Error: ${err.message}`);
    console.error(err);
  }

  isProcessing = false;
}

// ─── WALLET MONITOR ───────────────────────────────────────────────────────────

async function checkWallet() {
  if (isProcessing) return;
  try {
    const balance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
    if (balance > lastKnownBalance) {
      const diff   = balance - lastKnownBalance;
      const sigs   = await connection.getSignaturesForAddress(WALLET_KEYPAIR.publicKey, { limit: 3 });
      const newSig = sigs[0]?.signature;
      if (newSig && !processedSignatures.has(newSig)) {
        processedSignatures.add(newSig);
        if (processedSignatures.size > 200)
          processedSignatures.delete(processedSignatures.values().next().value);
        await processIncomingSOL(diff, newSig);
      }
    }
    lastKnownBalance = balance;
  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log('╔══════════════════════════════════════╗');
  log('║      TROLLER BURN BOT v3.0           ║');
  log('╚══════════════════════════════════════╝');
  log(`Wallet:      ${WALLET_KEYPAIR.publicKey.toString()}`);
  log(`$TROLLER:    ${TROLLER_MINT}`);
  log(`Helius Key:  ${HELIUS_API_KEY.substring(0, 8)}...`);
  log('');

  const actual   = WALLET_KEYPAIR.publicKey.toString();
  const expected = '4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB';
  if (actual !== expected) {
    log(`⚠️  Wallet mismatch! Expected ${expected}, got ${actual}`);
    process.exit(1);
  }

  // Test Helius quote endpoint
  log('Testing Helius Jupiter API...');
  try {
    const testUrl =
      `https://mainnet.helius-rpc.com/v0/quote` +
      `?api-key=${HELIUS_API_KEY}` +
      `&inputMint=So11111111111111111111111111111111111111112` +
      `&outputMint=${TROLLER_MINT}` +
      `&amount=1000000&slippageBps=500`;
    const { data } = await axios.get(testUrl, { timeout: 10000 });
    if (data?.outAmount) {
      log(`✅ Helius Jupiter API working! Test quote: ${Number(data.outAmount).toLocaleString()} $TROLLER per 0.001 SOL`);
    } else {
      log(`⚠️  Helius quote returned unexpected data: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    log(`⚠️  Helius Jupiter test failed: ${err.message}`);
    log('    Bot will still run but swaps may fail.');
  }

  lastKnownBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
  log(`Balance: ${(lastKnownBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log('Monitoring for incoming SOL...\n');

  setInterval(checkWallet, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
