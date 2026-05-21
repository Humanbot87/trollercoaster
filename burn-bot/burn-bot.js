require("dotenv").config();
const {
  Connection, PublicKey, Keypair, VersionedTransaction,
  TransactionMessage, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  getOrCreateAssociatedTokenAccount, createBurnInstruction,
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const axios = require("axios");
const bs58 = require("bs58");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TROLLER_MINT = "DDSnK25736sBknvGncjW43sxbWqHa155AihgBH4Npump";
const POLL_MS      = 10000;
const FEE_RESERVE  = 0.05;   // SOL to keep for fees
const MIN_SWAP_SOL = 0.02;

const RPC_URL = process.env.HELIUS_RPC;
if (!RPC_URL) { console.error("HELIUS_RPC not set"); process.exit(1); }

const WALLET = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const connection = new Connection(RPC_URL, "confirmed");
const trollerMint = new PublicKey(TROLLER_MINT);

let isProcessing = false;

function log(msg) {
  console.log("[" + new Date().toISOString() + "] " + msg);
}

// ─── GET LIVE PRICE ───────────────────────────────────────────────────────────
async function getTrollerPriceInSol() {
  const res = await axios.get(
    "https://api.dexscreener.com/latest/dex/tokens/" + TROLLER_MINT,
    { timeout: 8000 }
  );
  const price = parseFloat(res.data.pairs[0].priceNative);
  log("Live price: " + price + " SOL per $TROLLER | 1 SOL = " + Math.round(1 / price).toLocaleString() + " $TROLLER");
  return price;
}

// ─── SWAP SOL → $TROLLER ──────────────────────────────────────────────────────
async function swapSolForTroller(solAmount) {
  log("Swapping " + solAmount.toFixed(6) + " SOL -> $TROLLER via PumpPortal...");

  // Get live price and convert SOL to raw token units (6 decimals)
  const pricePerToken = await getTrollerPriceInSol();
  const tokenAmount = solAmount / pricePerToken;
  const rawAmount = Math.round(tokenAmount * 1_000_000); // 6 decimals
  log("Requesting: " + tokenAmount.toLocaleString() + " $TROLLER = " + rawAmount + " raw units for " + solAmount.toFixed(6) + " SOL");

  let serialized = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const slippage = attempt === 1 ? 25 : attempt === 2 ? 40 : 60;
    try {
      const res = await axios.post(
        "https://pumpportal.fun/api/trade-local",
        {
          action:      "buy",
          mint:        TROLLER_MINT,
          amount:      rawAmount,
          slippage:    slippage,
          priorityFee: 0,
          pool:        "pump-amm",
          publicKey:   WALLET.publicKey.toBase58(),
        },
        { responseType: "arraybuffer", timeout: 15000 }
      );
      if (res.data && res.data.byteLength >= 100) {
        serialized = new Uint8Array(res.data);
        log("PumpPortal quote OK slippage=" + slippage + "% attempt=" + attempt);
        break;
      } else {
        log("PumpPortal small response: " + (res.data ? res.data.byteLength : 0) + " bytes");
      }
    } catch (e) {
      log("PumpPortal attempt " + attempt + " failed: " + e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!serialized) throw new Error("PumpPortal: no valid TX after 3 attempts");

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const tx = VersionedTransaction.deserialize(serialized);
  tx.message.recentBlockhash = blockhash;
  tx.sign([WALLET]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });
  log("Swap TX sent: " + sig);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (status && status.value) {
        if (status.value.err) {
          log("Swap FAILED on-chain: " + JSON.stringify(status.value.err));
          return false;
        }
        const conf = status.value.confirmationStatus;
        if (conf === "confirmed" || conf === "finalized") {
          log("Swap confirmed -> https://solscan.io/tx/" + sig);
          return true;
        }
      }
    } catch (e) {}
  }
  log("Swap timeout -> https://solscan.io/tx/" + sig);
  return false;
}

// ─── BURN $TROLLER ────────────────────────────────────────────────────────────
async function burnTroller() {
  try {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, WALLET, trollerMint, WALLET.publicKey,
      false, "confirmed", {}, TOKEN_2022_PROGRAM_ID
    );
    const { value } = await connection.getTokenAccountBalance(ata.address);
    const amount = BigInt(value.amount);
    if (amount === 0n) { log("No $TROLLER to burn."); return false; }

    const uiAmount = (Number(amount) / Math.pow(10, value.decimals)).toLocaleString();
    log("Burning " + uiAmount + " $TROLLER...");

    const burnIx = createBurnInstruction(
      ata.address, trollerMint, WALLET.publicKey,
      amount, [], TOKEN_2022_PROGRAM_ID
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: WALLET.publicKey,
      recentBlockhash: blockhash,
      instructions: [burnIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([WALLET]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight }, "confirmed"
    );
    log("BURNED " + uiAmount + " $TROLLER -> https://solscan.io/tx/" + sig);
    return true;
  } catch (e) {
    log("Burn error: " + e.message);
    return false;
  }
}

// ─── SWEEP ────────────────────────────────────────────────────────────────────
async function trySweep() {
  if (isProcessing) return;
  try {
    const balance = await connection.getBalance(WALLET.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    const swappableSOL = balanceSOL - FEE_RESERVE;

    if (swappableSOL < MIN_SWAP_SOL) {
      log("Balance: " + balanceSOL.toFixed(6) + " SOL — waiting for SOL...");
      return;
    }

    isProcessing = true;
    log("=== SWEEP START ===");
    log("Balance: " + balanceSOL.toFixed(6) + " SOL | Swapping: " + swappableSOL.toFixed(6) + " SOL | Reserve: " + FEE_RESERVE + " SOL");

    const swapOk = await swapSolForTroller(swappableSOL);

    if (swapOk) {
      await new Promise(r => setTimeout(r, 5000));
      await burnTroller();
      log("=== SWEEP COMPLETE ===");
      await new Promise(r => setTimeout(r, 30000));
    } else {
      log("=== SWAP FAILED — retry next cycle ===");
      await new Promise(r => setTimeout(r, 10000));
    }
  } catch (e) {
    log("Sweep error: " + e.message);
    console.error(e);
  } finally {
    isProcessing = false;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log("╔══════════════════════════════════════╗");
  log("║      TROLLER BURN BOT v11.0          ║");
  log("╚══════════════════════════════════════╝");
  log("Wallet:   " + WALLET.publicKey.toString());
  log("Token:    " + TROLLER_MINT);
  log("Reserve:  " + FEE_RESERVE + " SOL");
  log("Min swap: " + MIN_SWAP_SOL + " SOL");
  log("Poll:     every " + (POLL_MS / 1000) + "s");
  log("");

  if (WALLET.publicKey.toString() !== "4jmogAxLmsQ54rJsRVQCAgeHt2ivgG8c8dkimjzFjWXB") {
    log("Wallet mismatch!"); process.exit(1);
  }

  const startBalance = await connection.getBalance(WALLET.publicKey);
  log("Startup balance: " + (startBalance / LAMPORTS_PER_SOL).toFixed(6) + " SOL");

  await trySweep();
  setInterval(trySweep, POLL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
