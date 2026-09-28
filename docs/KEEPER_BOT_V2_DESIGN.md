# Keeper Bot v2 Architecture & Cross-SDK Logic Parity

## 1. Executive Summary & Design Scope

The original keeper bot (`examples/keeper-bot`) was authored as a single-file CommonJS script prioritizing newcomer accessibility and contract exploration. While effective for learning, production operators running keepers competitively face requirements for concurrent task handling, granular shutdown draining, pluggable treasury/withdrawal strategies, and proactive lock-window re-checks.

**Keeper Bot v2** (`examples/keeper-bot-v2`) is introduced as a dedicated package designed for competitive operators without degrading the introductory clarity of `examples/keeper-bot`.

This document addresses:
1. **Core Architectural Decisions**: Package isolation, concurrency, persistence, shutdown, withdrawal, and scheduling models.
2. **Cross-SDK Logic Parity (Issue #405)**: A side-by-side comparison between Keeper Bot v2 and the Rust SDK (`rust-sdk` / `rust-sdk/examples/liquidation-keeper`) across **profitability calculation**, **retry classification**, and **lock-window awareness**.

---

## 2. Core Architectural Decisions

### 2.1 Package Relationship & Location
* **Decision**: Standalone package located at `examples/keeper-bot-v2`.
* **Rationale**: `CONTRIBUTING.md` establishes that `examples/keeper-bot` should remain simple, dependency-light, and beginner-friendly. Introducing worker pools, persistent databases, and multi-strategy registries into `examples/keeper-bot` would create cognitive overhead for first-time builders. Maintaining `examples/keeper-bot-v2` preserves `v1` for educational exploration while providing operators with a production-grade foundation.

### 2.2 Concurrency & Worker Management
* **Model**: Bounded worker pool where candidate tasks are claimed and executed concurrently up to a configurable concurrency limit (`CONCURRENCY_LIMIT`, default: 5).
* **Collision Prevention**: To prevent two internal workers in the same process from racing on the same task ID, candidate tasks are claimed in-memory in a pre-claim dispatch map before dispatching to the network.

### 2.3 Graceful Shutdown Under Concurrency (`src/shutdown.js`, Issue #402)
* **Guarantee**: When `SIGINT` or `SIGTERM` is captured, the bot immediately halts polling for new tasks.
* **Drain Discipline**: All active concurrent workers currently executing transactions or off-chain computations are tracked via `ShutdownCoordinator`. The process drains all in-flight workers so that no transaction is aborted mid-submission and task outcomes are cleanly recorded.
* **Bounded Drain Ceiling**: A hard timeout (`maxDrainMs`, default: 10,000ms) guarantees that a stalled RPC connection or hanging external script cannot keep the process deadlocked indefinitely.

### 2.4 Pluggable Withdrawal Strategy (`src/withdrawal.js`, Issue #400)
* **Default Parity**: `FixedThresholdStrategy` evaluates `balance >= WITHDRAW_THRESHOLD` (default 1 XLM), ensuring zero behavioral change when migrating from v1 to v2.
* **Reference Alternatives**:
  - `FixedScheduleStrategy`: Triggers withdrawals on a periodic schedule (e.g. hourly or daily) for predictable tax and accounting cycles.
  - `FeeAwareThresholdStrategy`: Lowers withdrawal thresholds during off-peak network fee windows and raises them during congestion.
* **Extensibility**: `WithdrawalManager` accepts any object or class implementing `evaluate({ balance, currentLedger, currentTimestamp, baseFee })`.

### 2.5 Lock-Window-Aware Scheduling (`src/scheduling.js`, Issue #399)
* **Contract Formula**: Mirrors `contracts/keeper-registry/src/internal.rs`:
  $$\text{unlock\_at} = \text{claim\_ledger} + \text{lock\_ledgers}$$
* **Proactive Scheduling**: When the bot discovers a task locked by a competing keeper, it computes $\text{unlock\_at}$ and tracks it in `LockWindowScheduler`. Once `current_ledger >= unlock_at`, the task is immediately re-evaluated.
* **Additive Dispatch**: Due tasks from the scheduler are merged additively with freshly polled tasks, giving priority to re-claim races while continuing to discover newly registered tasks.

---

## 3. Side-by-Side Logic Parity Review (Issue #405)

To ensure consistency across off-chain implementations interacting with the `KeeperRegistry` contract, this section reviews core logic between **Keeper Bot v2** (`examples/keeper-bot-v2`), the original bot (`examples/keeper-bot`), and the **Rust SDK** (`rust-sdk` and `rust-sdk/examples/liquidation-keeper`).

| Feature Domain | Keeper Bot v2 (`examples/keeper-bot-v2`) | Rust SDK (`rust-sdk` & `liquidation-keeper`) | Status & Agreement |
| :--- | :--- | :--- | :--- |
| **Profitability Calculation** | Pre-claim simulation estimating gas costs (`baseFee + resourceFee`), protocol fee deduction (`split_reward`), verifier proof cost, and minimum margin threshold (`netProfit >= minProfitMargin`). | `liquidation-keeper` checks `balance > 0` before calling `withdraw_rewards`. Tasks are selected by status (`Pending`) and type (`Liquidation`) without dynamic gas estimation. | **Intentional Difference**: The Rust SDK example is a minimal 55-line reference for testing client bindings. Keeper Bot v2 provides production fee-market modeling. |
| **Retry Classification** | Separates transport/network errors (transient: retried with exponential backoff & full jitter) from contract errors (permanent: simulation failure, `NotTaskClaimer`, `LockPeriodActive` never retried). | `rust-sdk/src/retry.rs` defines `RetryPolicy` and `default_classify`: `RpcCallError::Transport` is transient, `RpcCallError::Contract` is permanent. Default 4 attempts, 200ms base delay, 200ms jitter. | **Full Parity**: Exact alignment in classification semantics, backoff formula, and default retry parameters. |
| **Lock-Window Awareness** | Computes $\text{claim\_ledger} + \text{lock\_ledgers}$ with inclusive boundary ($\ge$). Proactively queues locked tasks for targeted re-check without full rescan. | Contract `internal.rs` enforces $\text{sequence} \ge \text{unlock\_at}$. The Rust SDK client exposes task status but leaves off-chain lock scheduling to consumers. | **Intentional Difference**: Contract arithmetic is mirrored identically. Scheduling is an operational feature implemented in Bot v2. |

---

### 3.1 Profitability Evaluation Analysis

#### Keeper Bot v2 Logic:
```javascript
// Step 1: Protocol fee split (matching internal.rs split_reward)
const protocolFee = (reward * BigInt(feeBps)) / 10000n;
const keeperNetReward = reward - protocolFee;

// Step 2: Transaction cost estimation (base fee + Soroban resource fee)
const totalEstimatedFees = BigInt(baseFee) + BigInt(minResourceFee) + verifierCost;

// Step 3: Profitability check against configured operator margin
const netProfit = keeperNetReward - totalEstimatedFees;
const profitable = netProfit >= BigInt(minProfitMargin);
```

#### Rust SDK Example Analysis:
In `rust-sdk/examples/liquidation-keeper/src/main.rs`:
```rust
for (idx, task_opt) in tasks.iter().enumerate() {
    if let Some(task) = task_opt {
        if task.task_type == TaskType::Liquidation && task.status == TaskStatus::Pending {
            raw_client.claim_task(&keeper_address, &task_id);
            ...
        }
    }
}
```
* **Review Finding**: The Rust SDK example does not simulate transaction costs or verify profitability before submitting `claim_task`.
* **Reasoning**: The Rust example serves as a lightweight integration test and demonstration of the `KeeperClient` API in a mocked test environment (`Env::default()`). Full gas estimation requires an active Soroban RPC server with simulation capabilities (`simulateTransaction`).
* **Conclusion**: This is an **intentional difference**. No bug or unintentional divergence was identified.

---

### 3.2 Retry Classification Analysis

#### Parity Verification:
1. **Keeper Bot (`index.js` & `v2`)**:
   - `isPermanentError`: Matches contract rejection phrases (`"simulation failed"`, `"already claimed"`, `"unauthorized"`, `"task not found"`).
   - Treats network timeouts, connection resets, and RPC `503` as transient.
2. **Rust SDK (`rust-sdk/src/retry.rs`)**:
   ```rust
   pub fn default_classify<C>(err: &RpcCallError<C>) -> ErrorClass {
       match err {
           RpcCallError::Transport(_) => ErrorClass::Transient,
           RpcCallError::Contract(_) => ErrorClass::Permanent,
       }
   }
   ```
* **Review Finding**: Both implementations follow the exact same invariant: **a decoded contract error indicates deterministic on-chain rejection and must never be retried**, whereas **transport failures indicate the call never reached the contract and may be safely retried**.
* **Conclusion**: **Full agreement**.

---

### 3.3 Lock-Window Awareness Analysis

#### Contract Invariant (`contracts/keeper-registry/src/internal.rs`):
```rust
pub(crate) fn lock_expired(e: &Env, task: &Task) -> bool {
    match task.claim_ledger {
        Some(claimed_at) => {
            let unlock_at = claimed_at.saturating_add(task.lock_ledgers);
            e.ledger().sequence() >= unlock_at
        }
        None => true,
    }
}
```

#### Keeper Bot v2 Scheduler (`src/scheduling.js`):
```javascript
function computeUnlockLedger(task) {
  const claimLedger = Number(task.claim_ledger ?? task.claimLedger);
  const lockLedgers = Number(task.lock_ledgers ?? task.lockLedgers);
  return claimLedger + lockLedgers;
}
```
* **Boundary Condition**: In both the contract and Keeper Bot v2, the boundary is **inclusive** (`>=`). At ledger $\text{claim\_ledger} + \text{lock\_ledgers}$ exactly, the lock is expired and the task is immediately claimable.
* **Review Finding**: Keeper Bot v2 tracks this boundary directly to schedule re-claims, preventing stale locks from lingering unaddressed until the next periodic poll.
* **Conclusion**: **Full agreement**.

---

## 4. Summary of Divergence Audit

During the cross-SDK audit, **no unintentional divergences or bugs were found** between Keeper Bot v2, the Rust SDK, and the core contract:
* All differences between the reference examples and production bots are deliberate design choices reflecting their respective roles (introductory documentation vs. competitive node operation).
* Arithmetic for fees, lock expiration, and retry backoff strictly adheres to the protocol specifications defined in `contracts/keeper-registry`.


## 5. Operational State, Prioritization, and Issue Requirements

### State Persistence Model

* **Problem**: v1 maintains no state across restarts or rounds, causing potential duplicate processing or lack of visibility into in-flight claims.
* **Solution**: `src/state.js` maintains task lifecycle states:
  * `DISCOVERED`: Task event picked up from ledger events or indexer.
  * `EVALUATING`: Profitability and eligibility checks in progress.
  * `CLAIMING` / `CLAIMED`: Task locked on-chain by this keeper.
  * `EXECUTING`: Off-chain computation in flight.
  * `EXECUTED`: Final `execute_task` completed on-chain.
  * `SKIPPED`: Task intentionally bypassed (with structured reason).
* Tasks marked `CLAIMING` or `CLAIMED` are locked within the local process, preventing concurrent internal workers from racing on the same task ID.

### Task Prioritization

* **Ranking by Expected Net Profit**: Candidate tasks discovered in a round are evaluated by expected net reward (`reward - estimatedGasFees`). Tasks are sorted descending by net profit.
* High-value tasks are claimed first, preventing lower-reward tasks from consuming available concurrency slots or budget allocations.

### Hard Ceiling on Per-Round Resource Spend (Issue #407)

#### Problem Statement
Concurrency and prioritization increase the volume of transactions a single keeper round can attempt. Without an explicit ceiling, candidate bursts (such as batch task registrations) or volatile network fee spikes could submit far more transactions than an operator intended, eroding margins or causing runaway fee spend.

#### Mechanism & Invariant Guarantees
1. **Configurable Ceiling**: Configured via `MAX_ROUND_SPEND_STROOPS` (default: 5,000,000 stroops = 0.5 XLM).
2. **Independent Backstop**: The spend ceiling is evaluated independently of task-level profitability. A task may have high expected profit, but if the round's cumulative spend has reached `MAX_ROUND_SPEND_STROOPS`, no further transactions (claims or executions) are dispatched in that round.
3. **Distinct Logging**: When the ceiling is reached, the keeper emits a distinct log:
   `[RESOURCE CEILING] Hard round spend ceiling reached: spent ${roundSpend} stroops (ceiling: ${maxSpend} stroops). Halting further submissions this round.`
4. **Metrics Tracking**: Increments `spend_ceiling_reached` in `src/metrics.js` and records skipped candidates under the structured skip reason `"spend_ceiling_reached"`.

---

### Multi-Keeper Competition & Lost-Race Handling (Issue #404)

#### Problem Statement
In production, multiple independent keeper bots compete to claim the same profitable tasks. In v1, an on-chain rejection due to a lost race (`TaskAlreadyClaimed`) was logged as an error and added to `summary.errors`, misrepresenting normal competitive dynamics as system failures.

#### Expected Behavior
1. **Success-with-Skip**: A lost claim race is recognized via `isLostClaimRaceError(err)` (matching error code 2 / `TaskAlreadyClaimed` / "already claimed" / "already locked" / "TaskNotPending"). It is treated as normal competition (`success-with-skip`), NOT logged as an error, and NOT appended to `summary.errors`.
2. **Round Continuation**: The bot logs `[COMPETITION] Task ${taskId} already claimed by competitor; treating as normal skip.` and immediately proceeds to evaluate remaining candidates in the queue.
3. **Metrics Distinction**: `src/metrics.js` records lost claim races under a dedicated counter `metrics.recordSkip("lost_claim_race", taskId)`, keeping it cleanly separated from `unprofitable`, `unsupported_executor`, or RPC errors.

---

### Deferral of Verifier-Aware Proof Generation (Issue #412)

#### Context and Problem Statement
Earlier backlog issues (`0090`, `0091`, and issues in the `0102`–`0140` range) proposed bot support for tasks gated by an on-chain verifier contract. Those design artifacts (`docs/VERIFIER_DESIGN.md`, `docs/VERIFIERS.md`) anticipated that keeper bots would synthesize zero-knowledge or external cryptographic proofs before executing tasks.

However, an audit of the deployed `KeeperRegistry` contract (`contracts/keeper-registry/src/`) reveals that **the contract-side verifier infrastructure does not exist**:
1. **Missing `Task.verifier` Field**: The `Task` struct on-chain has fields `id`, `owner`, `task_type`, `status`, `reward`, `calldata`, `deadline`, and `unlock_at`. It has **no** `verifier` field.
2. **Missing Entry Points**: The contract does **not** expose `update_verifier`, `set_verifier`, or `verify`.
3. **Missing Cross-Contract Invocation**: `execute_task` validates keeper locks, status, and caller authorization, but makes **no** cross-contract call to an external verifier.
4. **Placeholder Error Variant**: Only a placeholder error variant `IncompatibleVerifierInterface = 6` exists in `contracts/keeper-registry/src/errors.rs`, with no reachable code path inside the contract that ever constructs or returns it.

#### Explicit Deferral Policy
In accordance with Issue **#412**:
* **Explicit Dependency**: Verifier-aware proof generation in the bot is strictly blocked on the contract-side feature landing.
* **No Speculative Code**: **No bot code is written against an unimplemented verifier interface in keeper-bot-v2.** Building bot-side logic against a non-existent on-chain interface creates untestable dead code and misleads operators into believing the capability is operational.
* **Supersession Plan**: When the contract-side verifier capabilities are formally introduced (adding `Task.verifier`, registry verification entry points, and cross-contract validation in `execute_task`), this placeholder section will be superseded by active proof-generation implementations referencing the specific issue numbers assigned to that epic.

---

### Performance Benchmarking Methodology (Issue #413)

#### Benchmark Harness
The benchmark harness in `examples/keeper-bot-v2/benchmark/` tests Keeper Bot v1 (sequential) against Keeper Bot v2 (concurrent + prioritized) under strictly identical simulated conditions:
* **Workload**: 25 candidate tasks with heterogeneous reward distributions (50,000 to 1,500,000 stroops).
* **Simulated Network Latency**: Controlled 15ms delay per RPC simulation, claim, and execution call.
* **Contention**: 24% claim race rate (6 of 25 tasks) simulating mid-round claims by competing keeper bots.
* **v2 Concurrency**: 4 workers.
* **Spend Ceiling**: 5,000,000 stroops, enforced independently of task margins.
* **Metrics Recorded**:
  * Round Latency (ms)
  * Tasks Won / Executed
  * Net Profit Realized (stroops)
  * Error Counts & Lost Race Classification

#### Results (epic E15's evidence of value delivered)
The committed report (`examples/keeper-bot-v2/benchmark/REPORT.md`) recorded:

| Dimension | v1 (Sequential) | v2 (Concurrent & Prioritized) | Delta |
|---|---|---|---|
| Round Latency | 753 ms | 210 ms | **-72.1%** |
| Tasks Won | 19 | 19 | Same (contention bounded) |
| Net Profit | 15,960,000 stroops | 15,960,000 stroops | +0 |
| Reported Errors | 6 (false positives) | 0 | **-100%** |
| Lost Races Handled | 0 (counted as failure) | 6 (`success-with-skip`) | Resilient continuation |

The two headline results are the concurrency win (72.1% faster rounds, from overlapping RPC round trips across the worker pool rather than serializing them) and the observability fix (v1's 6 lost-claim-race false positives become 0 in v2, because a lost race is a normal competitive skip — see "Multi-Keeper Competition & Lost-Race Handling" above — not an error). Net profit and tasks won are identical, confirming v2's concurrency and spend-ceiling enforcement ("Hard Ceiling on Per-Round Resource Spend" above) do not trade correctness for speed.
