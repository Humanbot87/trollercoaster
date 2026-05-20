/**
 * TROLLER BURN BOT v4.0
 * ----------------------
 * Uses PumpPortal API for swaps (same as house-bot)
 * → Monitors wallet for incoming SOL
 * → Buys $TROLLER via PumpPortal
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
const POLL_INTERVAL_MS = 5000;
const MIN_SOL_TRIGGER  = 0.005;

const RPC_URL = process.env.HELIUS_RPC;
if (!RPC_URL) { console.error('HELIUS_RPC not set in .env'); process.exit(1); }

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

// ─── SWAP: SOL → $TROLLER via PumpPortal ──────────────────────────────────────

async function swapSolForTroller(solAmount) {
  log(`Swapping ${solAmount.toFixed(4)} SOL → $TROLLER via PumpPortal...`);

  // PumpPortal local trade API — same as house-bot uses
  const payload = {
    action: 'buy',
    mint: TROLLER_MINT,
    amount: solAmount,         // SOL amount
    denominatedInSol: 'true',
    slippage: 25,
    priorityFee: 0.001,
    pool: 'raydium',           // bonded token → raydium pool
  };

  let txBase64;
  try {
    const { data } = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        responseType: 'arraybuffer',
      }
    );
    txBase64 = Buffer.from(data).toString('base64');
  } catch (err) {
    throw new Error(`PumpPortal trade-local failed: ${err.message}`);
  }

  // Sign & send
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  log(`Swap TX sent: ${sig}`);

  // Confirm with timeout
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  log(`✅ Swap confirmed → https://solscan.io/tx/${sig}`);

  // Get actual $TROLLER balance received
  await new Promise(r => setTimeout(r, 3000)); // wait 3s for balance to update
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    WALLET_KEYPAIR,
    trollerMint,
    WALLET_KEYPAIR.publicKey
  );
  const { value } = await connection.getTokenAccountBalance(tokenAccount.address);
  const received = BigInt(value.amount);
  log(`Received: ${Number(received).toLocaleString()} $TROLLER (raw)`);

  return received;
}

// ─── BURN $TROLLER ─────────────────────────────────────────────────────────────

async function burnTroller(amount) {
  log(`Burning ${amount.toLocaleString()} $TROLLER (raw)...`);

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

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: WALLET_KEYPAIR.publicKey,
    recentBlockhash: blockhash,
    instructions: [burnIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

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
    log(`Amount too small (${solToBurn.toFixed(6)} SOL), skipping.`);
    isProcessing = false;
    return;
  }

  try {
    const trollerAmount = await swapSolForTroller(solToBurn);
    await burnTroller(trollerAmount);
    log(`✅ Complete: ${incomingSOL.toFixed(4)} SOL → $TROLLER → 🔥 BURNED\n`);
  } catch (err) {
    log(`❌ Error during swap/burn: ${err.message}`);
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
      const sigs   = await connection.getSignaturesForAddress(
        WALLET_KEYPAIR.publicKey, { limit: 3 }
      );
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
  log('║      TROLLER BURN BOT v4.0           ║');
  log('║      PumpPortal + Raydium            ║');
  log('╚══════════════════════════════════════╝');
  log(`Wallet:    ${WALLET_KEYPAIR.publicKey.toString()}`);
  log(`$TROLLER:  ${TROLLER_MINT}`);
  log(`Burn:      ${BURN_PERCENT * 100}%`);
  log(`Poll:      every ${POLL_INTERVAL_MS / 1000}s`);
  log('');

  const actual   = WALLET_KEYPAIR.publicKey.toString();
  const expected = '4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB';
  if (actual !== expected) {
    log(`⚠️  Wallet mismatch! Expected ${expected}, got ${actual}`);
    process.exit(1);
  }

  // Test PumpPortal connectivity
  log('Testing PumpPortal connectivity...');
  try {
    await axios.get('https://pumpportal.fun', { timeout: 5000 });
    log('✅ PumpPortal reachable');
  } catch (err) {
    log(`⚠️  PumpPortal test: ${err.message}`);
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
