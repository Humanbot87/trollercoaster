cat > /root/trollercoaster/burn-bot/burn-bot.js << 'BOTEOF'
/**
 * TROLLER BURN BOT v5.0
 */

require('dotenv').config();
const {
  Connection, PublicKey, Keypair, VersionedTransaction,
  TransactionMessage, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount, createBurnInstruction,
  TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const axios = require('axios');
const bs58 = require('bs58');

const TROLLER_MINT     = 'DDSnK25736sBknvGncjW43sxbWqHa155AihgBH4Npump';
const BURN_PERCENT     = 0.99;
const POLL_INTERVAL_MS = 5000;
const MIN_SOL_TRIGGER  = 0.005;
const FEE_RESERVE      = 0.01;

const RPC_URL = process.env.HELIUS_RPC;
if (!RPC_URL) { console.error('HELIUS_RPC not set'); process.exit(1); }

const WALLET_KEYPAIR = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const connection     = new Connection(RPC_URL, 'confirmed');
const trollerMint    = new PublicKey(TROLLER_MINT);

let lastKnownBalance    = 0;
let processedSignatures = new Set();
let isProcessing        = false;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function swapSolForTroller(solAmount) {
  log(`Swapping ${solAmount.toFixed(4)} SOL → $TROLLER...`);
  let serialized = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const slippagePct = attempt === 1 ? 25 : attempt === 2 ? 40 : 60;
    const priorityFee = 0.003 * attempt;
    try {
      const ppRes = await axios.post(
        'https://pumpportal.fun/api/trade-local',
        {
          action:           'buy',
          mint:             TROLLER_MINT,
          amount:           solAmount,
          denominatedInSol: 'true',
          slippage:         slippagePct,
          priorityFee:      priorityFee,
          pool:             'pump-amm',
          publicKey:        WALLET_KEYPAIR.publicKey.toBase58(),
        },
        { responseType: 'arraybuffer', timeout: 15000 }
      );
      if (ppRes.data && ppRes.data.byteLength >= 100) {
        serialized = new Uint8Array(ppRes.data);
        log(`PumpPortal OK (slippage ${slippagePct}%${attempt > 1 ? ` retry ${attempt}` : ''})`);
        break;
      }
    } catch (err) {
      log(`PumpPortal attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw new Error('PumpPortal all attempts failed');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!serialized) throw new Error('No TX from PumpPortal');

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = VersionedTransaction.deserialize(serialized);
  tx.message.recentBlockhash = blockhash;
  tx.sign([WALLET_KEYPAIR]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  log(`Swap TX sent: ${sig}`);

  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    log(`✅ Swap confirmed → https://solscan.io/tx/${sig}`);
  } catch (err) {
    if (err.message?.includes('block height exceeded') || err.message?.includes('expired')) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await connection.getSignatureStatus(sig);
      const conf = status?.value?.confirmationStatus;
      log(conf === 'confirmed' || conf === 'finalized'
        ? `✅ Swap confirmed (late) → https://solscan.io/tx/${sig}`
        : `⚠️ TX status unknown → https://solscan.io/tx/${sig}`);
    } else throw err;
  }

  await new Promise(r => setTimeout(r, 3000));

  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, WALLET_KEYPAIR, trollerMint, WALLET_KEYPAIR.publicKey,
    false, 'confirmed', {}, TOKEN_2022_PROGRAM_ID
  );
  const { value } = await connection.getTokenAccountBalance(tokenAccount.address);
  const received = BigInt(value.amount);
  log(`Received: ${(Number(received) / Math.pow(10, value.decimals)).toLocaleString()} $TROLLER`);
  return received;
}

async function burnTroller(amount) {
  log(`Burning $TROLLER...`);
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, WALLET_KEYPAIR, trollerMint, WALLET_KEYPAIR.publicKey,
    false, 'confirmed', {}, TOKEN_2022_PROGRAM_ID
  );
  const { value } = await connection.getTokenAccountBalance(tokenAccount.address);
  const available = BigInt(value.amount);
  if (available < amount) amount = available;
  if (amount === 0n) { log('No $TROLLER to burn.'); return; }

  const burnIx = createBurnInstruction(
    tokenAccount.address, trollerMint, WALLET_KEYPAIR.publicKey,
    amount, [], TOKEN_2022_PROGRAM_ID
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
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const uiAmount = (Number(amount) / Math.pow(10, value.decimals)).toLocaleString();
  log(`🔥 BURNED ${uiAmount} $TROLLER → https://solscan.io/tx/${sig}`);
}

async function sweepAndBurn(solBalance) {
  const sweepSOL = (solBalance - FEE_RESERVE * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  if (sweepSOL < MIN_SOL_TRIGGER) return;
  isProcessing = true;
  log(`💰 Sweep: ${sweepSOL.toFixed(4)} SOL → buying & burning $TROLLER...`);
  try {
    const trollerAmount = await swapSolForTroller(sweepSOL);
    await burnTroller(trollerAmount);
    log(`✅ Complete: ${sweepSOL.toFixed(4)} SOL → $TROLLER → 🔥 BURNED\n`);
  } catch (err) {
    log(`❌ Sweep error: ${err.message}`);
  }
  isProcessing = false;
  lastKnownBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
}

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
        // Sweep full balance minus fee reserve (not just the diff)
        await sweepAndBurn(balance);
        return;
      }
    }
    lastKnownBalance = balance;
  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}

async function main() {
  log('╔══════════════════════════════════════╗');
  log('║      TROLLER BURN BOT v5.0           ║');
  log('╚══════════════════════════════════════╝');
  log(`Wallet:   ${WALLET_KEYPAIR.publicKey.toString()}`);
  log(`$TROLLER: ${TROLLER_MINT}`);
  log(`Reserve:  ${FEE_RESERVE} SOL for fees`);
  log('');

  const actual = WALLET_KEYPAIR.publicKey.toString();
  if (actual !== '4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB') {
    log(`⚠️ Wallet mismatch! Got: ${actual}`);
    process.exit(1);
  }

  lastKnownBalance = await connection.getBalance(WALLET_KEYPAIR.publicKey);
  log(`Balance: ${(lastKnownBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Startup sweep — buy & burn everything above fee reserve
  if (lastKnownBalance > (FEE_RESERVE + MIN_SOL_TRIGGER) * LAMPORTS_PER_SOL) {
    log(`🚀 Startup sweep starting...`);
    await sweepAndBurn(lastKnownBalance);
  } else {
    log(`No startup sweep needed.`);
  }

  log('Monitoring for incoming SOL...\n');
  setInterval(checkWallet, POLL_INTERVAL_MS);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
BOTEOF

pm2 restart burn-bot
pm2 logs burn-bot --lines 20
