/**
 * TROLLER BURN BOT v2.0
 * ----------------------
 * Monitors wallet for incoming SOL
 * → Buys $TROLLER via Jupiter (with fallback endpoints)
 * → Burns $TROLLER on-chain automatically
 *
 * Token: DDSnK25736sBknvGncjW43sxbWqHa155AihgBH4Npump (bonded, on Raydium)
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

const RPC_URL = process.env.HELIUS_RPC || 'https://api.mainnet-beta.solana.com';

const WALLET_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEY)
);

// Jupiter endpoints — tries each in order until one works
const JUPITER_ENDPOINTS = [
  'https://quote-api.mainnet.jup.ag/v6',
  'https://public.jupiterapi.com/v6',
  'https://jupiter-quote-api-node.projectserum.com/v6',
];

// ─── SETUP ────────────────────────────────────────────────────────────────────

const connection  = new Connection(RPC_URL, 'confirmed');
const trollerMint = new PublicKey(TROLLER_MINT);

let lastKnownBalance    = 0;
let processedSignatures = new Set();
let isProcessing        = false;

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── JUPITER SWAP: SOL → $TROLLER ─────────────────────────────────────────────

async function getJupiterQuote(baseUrl, lamports) {
  const url =
    `${baseUrl}/quote` +
    `?inputMint=So11111111111111111111111111111111111111112` +
    `&outputMint=${TROLLER_MINT}` +
    `&amount=${lamports}` +
    `&slippageBps=500`;

  const { data } = await axios.get(url, { timeout: 10000 });
  return data;
}

async function getJupiterSwap(baseUrl, quote) {
  const { data } = await axios.post(
    `${baseUrl}/swap`,
    {
      quoteResponse: quote,
      userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
    { timeout: 15000 }
  );
  return data;
}

async function swapSolForTroller(solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  log(`Swapping ${solAmount.toFixed(4)} SOL → $TROLLER...`);

  let lastError;

  for (const endpoint of JUPITER_ENDPOINTS) {
    try {
      log(`Trying endpoint: ${endpoint}`);

      const quote = await getJupiterQuote(endpoint, lamports);
      if (!quote?.outAmount) throw new Error('No quote returned');

      log(`Quote OK: ${lamports} lamports → ${Number(quote.outAmount).toLocaleString()} $TROLLER`);

      const swapData = await getJupiterSwap(endpoint, quote);
      if (!swapData?.swapTransaction) throw new Error('No swap transaction');

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

    } catch (err) {
      log(`❌ Endpoint ${endpoint} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`All Jupiter endpoints failed. Last error: ${lastError?.message}`);
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
  log(`→ Keeping ${(incomingSOL * GAS_RESERVE).toFixed(4)} SOL for gas\n`);

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
        if (processedSignatures.size > 200) {
          processedSignatures.delete(processedSignatures.values().next().value);
        }
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
  log('║      TROLLER BURN BOT v2.0           ║');
  log('╚══════════════════════════════════════╝');
  log(`Wallet:    ${WALLET_KEYPAIR.publicKey.toString()}`);
  log(`$TROLLER:  ${TROLLER_MINT}`);
  log(`Burn:      ${BURN_PERCENT * 100}%`);
  log(`Poll:      every ${POLL_INTERVAL_MS / 1000}s`);
  log('');

  // Verify wallet
  const actual   = WALLET_KEYPAIR.publicKey.toString();
  const expected = '4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB';
  if (actual !== expected) {
    log(`⚠️  WARNING: Wallet mismatch!`);
    log(`   Expected: ${expected}`);
    log(`   Got:      ${actual}`);
    process.exit(1);
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
