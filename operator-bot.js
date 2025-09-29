import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  OPERATOR_KEY,
  PREDICTION_ADDRESS,
  ORACLE_ADDRESS,
  CHECK_INTERVAL = 1000, // 1s for tight polling
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,   // Must match contract
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY || !ORACLE_ADDRESS) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, OPERATOR_KEY, or ORACLE_ADDRESS');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

// Oracle contract instance
const oracleAbi = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function version() view returns (uint256)',
];
const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, provider);

let txPending = false;
let lastHandledEpoch = 0;
const lastAttemptedEpochs = new Map(); // Track last attempt time for each epoch

// --- Helpers ---
function ts(unix) {
  return new Date(Number(unix) * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTx(fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const tx = await fn({
        gasLimit: Number(GAS_LIMIT),
        gasPrice: ethers.parseUnits('1000', 'gwei'), // Fixed 1000 Gwei
        nonce,
      });
      console.log(`[operator-bot] 🚀 Tx sent: ${tx.hash}, nonce: ${nonce}, gasPrice: 1000 Gwei`);
      const receipt = await tx.wait(2); // Wait for 2 confirmations
      return receipt;
    } catch (err) {
      console.error(`[operator-bot] ❌ Tx failed (try ${attempt}): ${err.message}`);
      if (attempt === 5) {
        console.error(`[operator-bot] ❌ Max retries reached for tx`);
        throw err;
      }
      await sleep(1000);
    }
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce({ blockTag: 'latest' });
  const lockOnce = await prediction.genesisLockOnce({ blockTag: 'latest' });
  console.log(`[operator-bot] Genesis - StartOnce: ${startOnce}, LockOnce: ${lockOnce}`);

  if (!startOnce) {
    console.log('[operator-bot] ⚡ genesisStartRound');
    const r = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
    await sleep(1000);
    return true;
  }

  if (startOnce && !lockOnce) {
    const currentEpoch = Number(await prediction.currentEpoch({ blockTag: 'latest' }));
    const round = await prediction.rounds(currentEpoch, { blockTag: 'latest' });
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);

    if (now < lockTime) {
      console.log(`[operator-bot] ⏳ Waiting for genesis lock window: Now=${ts(now)}, Lock=${ts(lockTime)}`);
      return false; // Wait until lockTimestamp
    }

    console.log('[operator-bot] ⚡ genesisLockRound');
    try {
      const r = await sendTx((opts) => prediction.genesisLockRound(opts));
      console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
      await sleep(1000);
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ genesisLockRound failed: ${err.message}`);
      return false; // Retry on next loop
    }
  }

  return false;
}

// --- Try execute an epoch ---
async function tryExecute(epoch) {
  if (epoch <= lastHandledEpoch) return false;

  const now = Math.floor(Date.now() / 1000);
  const lastAttempt = lastAttemptedEpochs.get(epoch) || 0;
  const COOLDOWN_SECONDS = 15; // Prevent spamming executeRound
  if (now - lastAttempt < COOLDOWN_SECONDS) {
    console.log(`[operator-bot] ⏳ Skipping epoch ${epoch} due to cooldown (last attempt: ${ts(lastAttempt)})`);
    return false;
  }

  const round = await prediction.rounds(epoch, { blockTag: 'latest' });
  const lockTime = Number(round.lockTimestamp);
  const oracleCalled = round.oracleCalled;

  console.log(
    `[operator-bot] Checking epoch ${epoch}: Now=${ts(now)}, Lock=${ts(lockTime)}, OracleCalled=${oracleCalled}, In window=${now >= lockTime && now <= lockTime + Number(BUFFER_SECONDS)}`
  );

  // Check previous round's closeTimestamp to diagnose _safeEndRound issues
  let canEndPrevious = true;
  if (epoch >= 2) {
    const prevRound = await prediction.rounds(epoch - 2, { blockTag: 'latest' });
    console.log(
      `[operator-bot] Previous round (epoch ${epoch - 2}): closeTimestamp=${ts(prevRound.closeTimestamp)}, oracleCalled=${prevRound.oracleCalled}`
    );
    if (prevRound.closeTimestamp == 0 || now < Number(prevRound.closeTimestamp)) {
      console.log(`[operator-bot] Cannot end epoch ${epoch - 2}: closeTimestamp=${ts(prevRound.closeTimestamp)}, now=${ts(now)}`);
      canEndPrevious = false;
    }
  }

  // Valid execution window and previous round can be ended
  if (lockTime > 0 && oracleCalled && now >= lockTime && now <= lockTime + Number(BUFFER_SECONDS) && canEndPrevious) {
    console.log(`[operator-bot] ▶ Executing epoch ${epoch}`);
    txPending = true;
    lastAttemptedEpochs.set(epoch, now);
    try {
      const r = await sendTx((opts) => prediction.executeRound(opts));
      console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
      lastHandledEpoch = epoch;
      txPending = false;
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ Failed epoch ${epoch}: ${err.message}`);
      txPending = false;
      return false; // Retry on next loop
    }
  }

  // If oracleCalled is false, try to fetch price to ensure oracle data is available
  if (lockTime > 0 && !oracleCalled && now >= lockTime && canEndPrevious) {
    try {
      const oracleData = await oracle.latestRoundData();
      const oracleRoundId = oracleData[0].toString();
      const oracleTimestamp = Number(oracleData[3]);
      const oracleLatestRoundId = Number(await prediction.oracleLatestRoundId());
      const oracleUpdateAllowance = Number(await prediction.oracleUpdateAllowance());
      if (oracleRoundId > oracleLatestRoundId && oracleTimestamp <= now + oracleUpdateAllowance) {
        console.log(`[operator-bot] Oracle data available for epoch ${epoch}: roundId=${oracleRoundId}, timestamp=${ts(oracleTimestamp)}, allowance=${oracleUpdateAllowance}s`);
        // Force executeRound to update oracle
        console.log(`[operator-bot] ▶ Forcing executeRound for epoch ${epoch} to update oracle`);
        txPending = true;
        lastAttemptedEpochs.set(epoch, now);
        try {
          const r = await sendTx((opts) => prediction.executeRound(opts));
          console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
          lastHandledEpoch = epoch;
          txPending = false;
          return true;
        } catch (err) {
          console.error(`[operator-bot] ❌ Forced executeRound failed for epoch ${epoch}: ${err.message}`);
          txPending = false;
          return false; // Retry on next loop
        }
      } else {
        console.log(`[operator-bot] Oracle data invalid for epoch ${epoch}: roundId=${oracleRoundId}, contract oracleLatestRoundId=${oracleLatestRoundId}, timestamp=${ts(oracleTimestamp)}, allowance=${oracleUpdateAllowance}s`);
      }
    } catch (err) {
      console.error(`[operator-bot] ❌ Oracle check failed for epoch ${epoch}: ${err.message}`);
    }
  }

  // Log missed epoch or oracle delay but don’t mark as handled
  if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch} (waiting for oracle or next epoch)`);
    return false; // Keep retrying
  }

  if (lockTime > 0 && !oracleCalled) {
    console.log(`[operator-bot] ⏳ Waiting for oracle update on epoch ${epoch}`);
    return false; // Wait for oracle
  }

  if (!canEndPrevious) {
    console.log(`[operator-bot] ⏳ Waiting for previous round (epoch ${epoch - 2}) to be ended`);
    return false; // Wait for previous round
  }

  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    // Validate configuration
    const contractBuffer = await prediction.bufferSeconds();
    const intervalSeconds = await prediction.intervalSeconds();
    const oracleUpdateAllowance = await prediction.oracleUpdateAllowance();
    if (Number(contractBuffer) !== Number(BUFFER_SECONDS)) {
      console.error(`[operator-bot] BUFFER_SECONDS mismatch: env=${BUFFER_SECONDS}, contract=${contractBuffer}`);
    }

    // Update oracleUpdateAllowance if too small
    if (Number(oracleUpdateAllowance) < 3600) {
      console.warn(`[operator-bot] ⚠️ oracleUpdateAllowance (${oracleUpdateAllowance}) is too small, attempting to update to 3600s`);
      try {
        const tx = await prediction.setOracleUpdateAllowance(3600, {
          gasLimit: 200000,
          gasPrice: ethers.parseUnits('1000', 'gwei'),
        });
        console.log(`[operator-bot] Set oracleUpdateAllowance tx: ${tx.hash}`);
        await tx.wait(2);
        console.log(`[operator-bot] ✅ oracleUpdateAllowance updated to 3600s`);
      } catch (err) {
        console.error(`[operator-bot] ❌ Failed to update oracleUpdateAllowance: ${err.message}`);
      }
    }

    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const currentEpoch = Number(await prediction.currentEpoch({ blockTag: 'latest' }));

    // Prioritize current and next epoch, scan recent ones as fallback
    for (const e of [currentEpoch, currentEpoch + 1, ...Array.from({ length: 3 }, (_, i) => currentEpoch - i - 1)]) {
      if (e > 0 && e > lastHandledEpoch) {
        const executed = await tryExecute(e);
        if (executed) {
          lastHandledEpoch = e; // Update only on successful execution
          break; // Exit loop after successful execution
        }
      }
    }

    // Warn if epochs aren’t advancing
    if (currentEpoch <= lastHandledEpoch && currentEpoch > 0) {
      console.warn(`[operator-bot] ⚠️ Epoch not advancing (current: ${currentEpoch}, last: ${lastHandledEpoch})`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

// --- Monitoring ---
setInterval(async () => {
  try {
    const epoch = await prediction.currentEpoch({ blockTag: 'latest' });
    const oracleRoundId = Number(await prediction.oracleLatestRoundId());
    const paused = await prediction.paused({ blockTag: 'latest' });
    const startOnce = await prediction.genesisStartOnce({ blockTag: 'latest' });
    const lockOnce = await prediction.genesisLockOnce({ blockTag: 'latest' });
    const oracleUpdateAllowance = Number(await prediction.oracleUpdateAllowance());
    const oracleData = await oracle.latestRoundData();
    const round = await prediction.rounds(epoch, { blockTag: 'latest' });
    console.log(
      `[operator-bot] Monitor - Epoch: ${epoch}, Oracle Round ID: ${oracleRoundId}, Paused: ${paused}, GenesisStartOnce: ${startOnce}, GenesisLockOnce: ${lockOnce}, OracleUpdateAllowance: ${oracleUpdateAllowance}, Oracle Data: { roundId: ${oracleData[0].toString()}, price: ${oracleData[1].toString()}, timestamp: ${ts(oracleData[3].toString())} }, Current Round: { lockTimestamp: ${ts(round.lockTimestamp)}, oracleCalled: ${round.oracleCalled}, startTimestamp: ${ts(round.startTimestamp)}, closeTimestamp: ${ts(round.closeTimestamp)} }`
    );
    // Log previous round to diagnose _safeEndRound
    if (epoch >= 2) {
      const prevRound = await prediction.rounds(epoch - 2, { blockTag: 'latest' });
      console.log(
        `[operator-bot] Previous Round (epoch ${epoch - 2}): closeTimestamp=${ts(prevRound.closeTimestamp)}, oracleCalled=${prevRound.oracleCalled}`
      );
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Monitor error: ${err.message}`);
  }
}, 3000); // Check every 3s for faster detection

// Monitor RPC health
provider.on('error', (err) => console.error(`[operator-bot] ❌ RPC error: ${err.message}`));

// Validate operator
(async () => {
  try {
    const operator = await prediction.operatorAddress();
    if (operator !== wallet.address) {
      console.error(`[operator-bot] ❌ Wallet ${wallet.address} is not operator (${operator})`);
    } else {
      console.log(`[operator-bot] ✅ Wallet ${wallet.address} is operator`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Operator check failed: ${err.message}`);
  }
})();

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
