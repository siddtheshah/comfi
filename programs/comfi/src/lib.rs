use anchor_lang::prelude::*;

pub mod deployer;
pub mod pool;

pub use deployer::*;
pub use pool::*;

// Devnet/localnet program ID derived from target/deploy/comfi-keypair.json.
declare_id!("bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY");

#[program]
pub mod comfi {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        quote_authority: Pubkey,
    ) -> Result<()> {
        deployer::deployer_handlers::initialize_global_config(ctx, quote_authority)
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        new_treasury_usdc: Pubkey,
        new_quote_authority: Pubkey,
    ) -> Result<()> {
        deployer::deployer_handlers::update_global_config(ctx, new_treasury_usdc, new_quote_authority)
    }

    pub fn pause_new_pool_creation(ctx: Context<UpdateGlobalConfig>, paused: bool) -> Result<()> {
        deployer::deployer_handlers::pause_new_pool_creation(ctx, paused)
    }

    pub fn create_pool(ctx: Context<CreatePool>, args: CreatePoolArgs) -> Result<()> {
        deployer::deployer_handlers::create_pool(ctx, args)
    }

    pub fn join_pool(ctx: Context<JoinPool>, args: JoinPoolArgs) -> Result<()> {
        pool::pool_handlers::join_pool(ctx, args)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        pool::pool_handlers::deposit(ctx, amount)
    }

    pub fn set_alias(
        ctx: Context<MemberOnly>,
        alias_hash: [u8; 32],
        encryption_public_key: [u8; 32],
    ) -> Result<()> {
        pool::pool_handlers::set_alias(ctx, alias_hash, encryption_public_key)
    }

    pub fn set_paused(ctx: Context<MemberOnly>, paused: bool) -> Result<()> {
        pool::pool_handlers::set_paused(ctx, paused)
    }

    pub fn run_sponsored_set_alias(
        ctx: Context<RunSponsoredSetAlias>,
        quote: SponsorQuote,
        alias_hash: [u8; 32],
        encryption_public_key: [u8; 32],
    ) -> Result<()> {
        pool::pool_handlers::run_sponsored_set_alias(ctx, quote, alias_hash, encryption_public_key)
    }

    pub fn roll_cycle(ctx: Context<RollCycle>) -> Result<()> {
        pool::pool_handlers::roll_cycle(ctx)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn test_roll_cycle(ctx: Context<TestPoolOnly>) -> Result<()> {
        pool::pool_handlers::test_roll_cycle(ctx)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn test_advance_cycles(ctx: Context<TestPoolOnly>, count: u64) -> Result<()> {
        pool::pool_handlers::test_advance_cycles(ctx, count)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn test_set_cycle(ctx: Context<TestPoolOnly>, cycle: u64) -> Result<()> {
        pool::pool_handlers::test_set_cycle(ctx, cycle)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn test_finalize_proposal(ctx: Context<TestFinalizeProposal>) -> Result<()> {
        pool::pool_handlers::test_finalize_proposal(ctx)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn test_reset_member_allowance(ctx: Context<TestMemberOnly>) -> Result<()> {
        pool::pool_handlers::test_reset_member_allowance(ctx)
    }

    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, args: WithdrawalArgs) -> Result<()> {
        pool::pool_handlers::request_withdrawal(ctx, args)
    }

    pub fn create_proposal(ctx: Context<CreateProposal>, action: ProposalAction) -> Result<()> {
        pool::pool_handlers::create_proposal(ctx, action)
    }

    pub fn vote(ctx: Context<Vote>, approve: bool) -> Result<()> {
        pool::pool_handlers::vote(ctx, approve)
    }

    pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
        pool::pool_handlers::finalize_proposal(ctx)
    }

    pub fn execute_spender_limit(ctx: Context<ExecuteSpenderLimit>) -> Result<()> {
        pool::pool_handlers::execute_spender_limit(ctx)
    }

    pub fn execute_configuration_modification(
        ctx: Context<ExecuteConfigurationModification>,
    ) -> Result<()> {
        pool::pool_handlers::execute_configuration_modification(ctx)
    }

    pub fn execute_close_pool(ctx: Context<ExecuteClosePool>) -> Result<()> {
        pool::pool_handlers::execute_close_pool(ctx)
    }

    pub fn spend(ctx: Context<Spend>) -> Result<()> {
        pool::pool_handlers::spend(ctx)
    }

    pub fn claim_closure_refund(ctx: Context<ClaimClosureRefund>) -> Result<()> {
        pool::pool_handlers::claim_closure_refund(ctx)
    }
}

#[error_code]
pub enum ComfiError {
    #[msg("Only the pool's pinned USDC mint is accepted.")]
    WrongMint,
    #[msg("The supplied treasury does not match global configuration.")]
    InvalidTreasury,
    #[msg("New pool creation is paused.")]
    NewPoolsPaused,
    #[msg("The member cap is invalid.")]
    InvalidMemberCap,
    #[msg("The voting threshold is invalid.")]
    InvalidVoteThreshold,
    #[msg("Pool membership is full.")]
    MemberCapReached,
    #[msg("Deposit is below the pool minimum.")]
    DepositBelowMinimum,
    #[msg("Amount must be positive.")]
    InvalidAmount,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Caller is not authorized for this action.")]
    Unauthorized,
    #[msg("Invalid pool vault.")]
    InvalidVault,
    #[msg("Member is not a funded voting member.")]
    MemberNotFunded,
    #[msg("Member is not an approved spender.")]
    NotSpender,
    #[msg("Proposal is not open.")]
    ProposalNotOpen,
    #[msg("Voting has not started yet.")]
    VotingNotStarted,
    #[msg("Voting has closed.")]
    VotingClosed,
    #[msg("Voting deadline has not passed.")]
    VotingStillOpen,
    #[msg("Proposal is not executable.")]
    ProposalNotExecutable,
    #[msg("Proposal timelock is still active.")]
    TimelockActive,
    #[msg("Proposal action does not match this instruction.")]
    WrongProposalAction,
    #[msg("Proposal target does not match supplied account.")]
    ProposalTargetMismatch,
    #[msg("Withdrawal request is not pending.")]
    RequestNotPending,
    #[msg("A passed proposal is required for this request.")]
    ProposalRequired,
    #[msg("Recipient token account differs from the request.")]
    RecipientMismatch,
    #[msg("Spend would exceed the approved cycle limit.")]
    SpendLimitExceeded,
    #[msg("Spend cycle does not match the pool cycle.")]
    WrongCycle,
    #[msg("Invalid spender cycle.")]
    InvalidSpendCycle,
    #[msg("Funding cycle duration must be positive.")]
    InvalidCycleDuration,
    #[msg("The current funding cycle has not ended.")]
    CycleNotReady,
    #[msg("Sponsor quote action is not permitted by this instruction.")]
    WrongSponsoredAction,
    #[msg("Sponsor quote is for a different pool.")]
    QuotePoolMismatch,
    #[msg("Sponsor quote is for a different member.")]
    QuoteMemberMismatch,
    #[msg("Sponsor quote has expired.")]
    QuoteExpired,
    #[msg("Sponsor charge exceeds this pool's action limit.")]
    SponsorChargeTooHigh,
    #[msg("Sponsor charge would exceed the member's cycle allowance.")]
    ActionAllowanceExceeded,
    #[msg("Missing the required preceding Ed25519 quote verification.")]
    MissingQuoteVerification,
    #[msg("Sponsor quote signature or signed message is invalid.")]
    InvalidQuoteSignature,
    #[msg("This pool is not enabled for testing.")]
    TestingNotEnabled,
    #[msg("Proposal deadline cycles must be greater than zero.")]
    InvalidProposalDeadline,
    #[msg("Overfunding cap exceeded.")]
    OverfundingCapExceeded,
    #[msg("Pool is in the process of closing.")]
    PoolIsClosing,
    #[msg("Pool is not closing.")]
    PoolNotClosing,
    #[msg("Insufficient vault balance to satisfy priority surplus.")]
    InsufficientVaultForSurplus,
    #[msg("Closure refund has already been claimed.")]
    ClosureRefundAlreadyClaimed,
    #[msg("No refund is owed to this member.")]
    NoRefundOwed,
    #[msg("The cycle period has passed. A roll_cycle operation must be triggered before any other operations can be done.")]
    CycleRollRequired,
    #[msg("All pool members must be provided to roll_cycle to update member funded statuses.")]
    IncompleteMemberList,
    #[msg("The pool is currently locked due to low participation quorum.")]
    PoolLocked,
    #[msg("The configured quorum threshold is invalid.")]
    InvalidQuorumConfig,
    #[msg("This operation is not permitted while the pool is in a locked state.")]
    LockedOperationForbidden,
}

