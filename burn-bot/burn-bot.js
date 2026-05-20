/**
 * TROLLER BURN BOT
 * ----------------
 * Monitors wallet for incoming SOL
 * → Buys $TROLLER on Jupiter with 99%
 * → Burns $TROLLER on-chain automatically
 *
 * Single wallet setup — same wallet receives SOL and executes burns.
 *
 * Requirements:
 *   node >= 18
 *   npm install @solana/web3.js @solana/spl-token axios dotenv bs58
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
const BURN_PERCENT     = 0.99;   // 99% of incoming SOL → buy & burn
const GAS_RESERVE      = 0.01;   // 1% stays for transaction fees
const POLL_INTERVAL_MS = 5000;   // check every 5 seconds
const MIN_SOL_TRIGGER  = 0.005;  // ignore dust below this amount

// RPC — set HELIUS_RPC in .env
const RPC_URL = process.env.HELIUS_RPC || 'https://api.mainnet-beta.solana.com';

// Single wallet: receives SOL AND executes swaps/burns
// Set WALLET_PRIVATE_KEY in .env (base58 private key)
const WALLET_KEYPAIR = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEY)
);

// ─── SETUP ────────────────────────────────────────────────────────────────────

const connection  = new Connection(RPC_URL, 'confirmed');
const trollerMint = new PublicKey(TROLLER_MINT);

let lastKnownBalance     = 0;
let processedSignatures  = new Set();
let isProcessing         = false; // prevent overlapping runs

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── JUPITER SWAP: SOL → $TROLLER ─────────────────────────────────────────────

async function swapSolForTroller(solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  log(`Swapping ${solAmount.toFixed(4)} SOL → $TROLLER via Jupiter...`);

  // 1. Get quote
  const quoteUrl =
    `https://quote-api.jup.ag/v6/quote` +
    `?inputMint=So11111111111111111111111111111111111111112` +
    `&outputMint=${TROLLER_MINT}` +
    `&amount=${lamports}` +
    `&slippageBps=300`;

  const { data: quote } = await axios.get(quoteUrl);
  if (!quote?.outAmount) throw new Error('Jupiter quote failed: ' + JSON.stringify(quote));

  log(`Quote: ${lamports} lamports → ${Number(quote.outAmount).toLocaleString()} $TROLLER`);

  // 2. Get swap transaction
  const { data: swapData } = await axios.post('https://quote-api.jup.ag/v6/swap', {
    quoteResponse: quote,
    userPublicKey: WALLET_KEYPAIR.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  });

  if (!swapData?.swapTransaction) throw new Error('No swap transaction from Jupiter');

  // 3. Sign & send
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');

  log(`Swap confirmed → https://solscan.io/tx/${sig}`);
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

  // Use actual balance if lower than expected
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
      const diff = balance - lastKnownBalance;
      const sigs  = await connection.getSignaturesForAddress(WALLET_KEYPAIR.publicKey, { limit: 3 });
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
  log('║      TROLLER BURN BOT v1.0           ║');
  log('╚══════════════════════════════════════╝');
  log(`Wallet:    ${WALLET_KEYPAIR.publicKey.toString()}`);
  log(`$TROLLER:  ${TROLLER_MINT}`);
  log(`Burn:      ${BURN_PERCENT * 100}%`);
  log(`Gas:       ${GAS_RESERVE * 100}%`);
  log(`Poll:      every ${POLL_INTERVAL_MS / 1000}s`);
  log('');

  // Verify wallet matches expected address
  const actual = WALLET_KEYPAIR.publicKey.toString();
  const expected = '4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB';
  if (actual !== expected) {
    log(`⚠️  WARNING: Wallet mismatch!`);
    log(`   Expected: ${expected}`);
    log(`   Got:      ${actual}`);
    log(`   Check your WALLET_PRIVATE_KEY in .env`);
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
