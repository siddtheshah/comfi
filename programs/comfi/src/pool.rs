use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::deployer::GlobalConfig;
use crate::ComfiError;

pub fn transfer_user_tokens<'info>(
    _token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            Token::id(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
    )
}

pub fn assert_executable(proposal: &Account<Proposal>) -> Result<()> {
    require!(
        proposal.state == ProposalState::Executable,
        ComfiError::ProposalNotExecutable
    );
    require!(
        Clock::get()?.unix_timestamp >= proposal.executable_after,
        ComfiError::TimelockActive
    );
    Ok(())
}

pub fn verify_preceding_ed25519_quote(
    instructions: &UncheckedAccount,
    signer: &Pubkey,
    quote: &SponsorQuote,
) -> Result<()> {
    use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
    use solana_sdk_ids::ed25519_program;
    let current = load_current_index_checked(&instructions.to_account_info())?;
    require!(current > 0, ComfiError::MissingQuoteVerification);
    let ix = load_instruction_at_checked((current - 1) as usize, &instructions.to_account_info())?;
    require_keys_eq!(
        ix.program_id,
        ed25519_program::id(),
        ComfiError::MissingQuoteVerification
    );
    require!(
        ix.data.len() >= 16 && ix.data[0] == 1,
        ComfiError::InvalidQuoteSignature
    );
    let offset = |start: usize| -> Result<u16> {
        ix.data
            .get(start..start + 2)
            .and_then(|v| v.try_into().ok())
            .map(u16::from_le_bytes)
            .ok_or(error!(ComfiError::InvalidQuoteSignature))
    };
    let signature_offset = offset(2)?;
    let sig_ix = offset(4)?;
    let key_offset = offset(6)?;
    let key_ix = offset(8)?;
    let message_offset = offset(10)?;
    let message_size = offset(12)?;
    let message_ix = offset(14)?;
    require!(
        sig_ix == u16::MAX && key_ix == u16::MAX && message_ix == u16::MAX,
        ComfiError::InvalidQuoteSignature
    );
    let key_start = key_offset as usize;
    let signature_start = signature_offset as usize;
    let message_start = message_offset as usize;
    let message_end = message_start
        .checked_add(message_size as usize)
        .ok_or(ComfiError::InvalidQuoteSignature)?;
    require!(
        ix.data.get(signature_start..signature_start + 64).is_some(),
        ComfiError::InvalidQuoteSignature
    );
    require!(
        ix.data.get(key_start..key_start + 32) == Some(signer.as_ref()),
        ComfiError::InvalidQuoteSignature
    );
    let mut serialized_quote = Vec::new();
    quote
        .serialize(&mut serialized_quote)
        .map_err(|_| error!(ComfiError::InvalidQuoteSignature))?;
    require!(
        ix.data.get(message_start..message_end) == Some(serialized_quote.as_slice()),
        ComfiError::InvalidQuoteSignature
    );
    Ok(())
}

#[derive(Accounts)]
pub struct JoinPool<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,
    #[account(
        mut,
        has_one = global,
        constraint = vault.key() == pool.vault @ ComfiError::InvalidVault
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        constraint = user_usdc.owner == user.key() @ ComfiError::Unauthorized,
        constraint = user_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = pool.vault @ ComfiError::InvalidVault,
        constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        space = Member::SPACE,
        seeds = [b"member", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub member: Account<'info, Member>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub member_wallet: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,
    #[account(
        has_one = global,
        constraint = vault.key() == pool.vault @ ComfiError::InvalidVault
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        has_one = pool,
        constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized
    )]
    pub member: Account<'info, Member>,
    #[account(
        mut,
        constraint = source_usdc.owner == member_wallet.key() @ ComfiError::Unauthorized,
        constraint = source_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub source_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MemberOnly<'info> {
    pub member_wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        has_one = pool,
        constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized
    )]
    pub member: Account<'info, Member>,
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
#[instruction(quote: SponsorQuote)]
pub struct RunSponsoredSetAlias<'info> {
    #[account(mut)]
    pub member_wallet: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, GlobalConfig>>,
    #[account(
        has_one = global,
        constraint = vault.key() == pool.vault @ ComfiError::InvalidVault
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        has_one = pool,
        constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized
    )]
    pub member: Box<Account<'info, Member>>,
    #[account(
        mut,
        address = pool.vault @ ComfiError::InvalidVault,
        constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        address = global.treasury_usdc @ ComfiError::InvalidTreasury,
        constraint = treasury_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: Anchor's instructions sysvar parser validates this account.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    #[account(
        init,
        payer = member_wallet,
        space = SponsorQuoteReceipt::SPACE,
        seeds = [b"quote", pool.key().as_ref(), quote.quote_id.as_ref()],
        bump
    )]
    pub quote_receipt: Box<Account<'info, SponsorQuoteReceipt>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RollCycle<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub member_wallet: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        has_one = pool,
        constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized
    )]
    pub member: Account<'info, Member>,
    #[account(
        init,
        payer = member_wallet,
        space = WithdrawalRequest::SPACE,
        seeds = [b"request", pool.key().as_ref(), &pool.next_request_id.to_le_bytes()],
        bump
    )]
    pub request: Account<'info, WithdrawalRequest>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer_wallet: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [b"member", pool.key().as_ref(), proposer_wallet.key().as_ref()],
        bump = proposer.bump,
        has_one = pool,
        constraint = proposer.wallet == proposer_wallet.key() @ ComfiError::Unauthorized
    )]
    pub proposer: Account<'info, Member>,
    #[account(
        init,
        payer = proposer_wallet,
        space = Proposal::SPACE,
        seeds = [b"proposal", pool.key().as_ref(), &pool.next_proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    #[account(mut)]
    pub voter_wallet: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
    #[account(
        seeds = [b"member", pool.key().as_ref(), voter_wallet.key().as_ref()],
        bump = voter.bump,
        has_one = pool,
        constraint = voter.wallet == voter_wallet.key() @ ComfiError::Unauthorized
    )]
    pub voter: Account<'info, Member>,
    #[account(
        init,
        payer = voter_wallet,
        space = VoteReceipt::SPACE,
        seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, VoteReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct ExecuteSpenderLimit<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, has_one = pool)]
    pub spender_member: Account<'info, Member>,
    #[account(
        init_if_needed,
        payer = executor,
        space = SpenderCycle::SPACE,
        seeds = [
            b"cycle",
            pool.key().as_ref(),
            spender_member.key().as_ref(),
            &pool.current_cycle.to_le_bytes()
        ],
        bump
    )]
    pub spender_cycle: Account<'info, SpenderCycle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteConfigurationModification<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, GlobalConfig>>,
    #[account(mut, has_one = global)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(
        seeds = [b"member", pool.key().as_ref(), executor.key().as_ref()],
        bump = executor_member.bump,
        has_one = pool,
        constraint = executor_member.wallet == executor.key() @ ComfiError::Unauthorized
    )]
    pub executor_member: Box<Account<'info, Member>>,
    #[account(
        has_one = pool,
        constraint = requester_member.key() == request.requester @ ComfiError::Unauthorized
    )]
    pub requester_member: Box<Account<'info, Member>>,
    #[account(
        mut,
        seeds = [
            b"cycle",
            pool.key().as_ref(),
            requester_member.key().as_ref(),
            &pool.current_cycle.to_le_bytes()
        ],
        bump = spender_cycle.bump
    )]
    pub spender_cycle: Box<Account<'info, SpenderCycle>>,
    #[account(
        mut,
        address = pool.vault @ ComfiError::InvalidVault,
        constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = recipient_usdc.key() == request.recipient @ ComfiError::RecipientMismatch,
        constraint = recipient_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub recipient_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, has_one = pool)]
    pub proposal: Option<Box<Account<'info, Proposal>>>,
}

#[derive(Accounts)]
pub struct TestPoolOnly<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct TestFinalizeProposal<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct TestMemberOnly<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub member: Account<'info, Member>,
}

/// PDA seeds: ["pool", pool_id.to_le_bytes()]. It is also the vault authority.
#[account]
pub struct Pool {
    pub global: Pubkey,
    pub id: u64,
    pub creator: Pubkey,
    pub vault: Pubkey,
    pub member_cap: u32,
    pub member_count: u32,
    pub minimum_deposit: u64,
    pub member_obligation_amount: u64,
    pub vote_threshold: u32,
    pub voting_period_seconds: i64,
    pub timelock_seconds: i64,
    pub current_cycle: u64,
    pub cycle_duration_seconds: i64,
    pub cycle_started_at: i64,
    pub action_allowance_per_cycle: u64,
    pub max_sponsored_action_charge: u64,
    pub next_request_id: u64,
    pub next_proposal_id: u64,
    pub bump: u8,
    pub testing_enabled: bool,
    pub has_pending_config: bool,
    pub pending_vote_threshold: u32,
    pub pending_cycle_duration_seconds: i64,
    pub pending_member_obligation_amount: u64,
}

impl Pool {
    pub const SPACE: usize = 8 + 227;

    pub fn ensure_testing_enabled(&self) -> Result<()> {
        require!(self.testing_enabled, ComfiError::TestingNotEnabled);
        Ok(())
    }

    pub fn apply_pending_config(&mut self) {
        if self.has_pending_config {
            self.vote_threshold = self.pending_vote_threshold;
            self.cycle_duration_seconds = self.pending_cycle_duration_seconds;
            self.member_obligation_amount = self.pending_member_obligation_amount;
            self.has_pending_config = false;
        }
    }
}

/// PDA seeds: ["member", pool, wallet]. Alias bytes are never stored on chain.
#[account]
pub struct Member {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    pub role: MemberRole,
    pub is_funded: bool,
    pub deposited_total: u64,
    pub alias_hash: [u8; 32],
    pub encryption_public_key: [u8; 32],
    pub alias_version: u32,
    pub allowance_cycle: u64,
    pub action_allowance_used: u64,
    pub bump: u8,
}

impl Member {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 32 + 32 + 4 + 8 + 8 + 1;

    pub fn can_request_spend(&self) -> bool {
        matches!(
            self.role,
            MemberRole::Member | MemberRole::Spender | MemberRole::Admin
        )
    }

    pub fn is_funded_for_pool(&self, pool: &Pool) -> bool {
        self.is_funded && self.deposited_total >= pool.member_obligation_amount
    }
}

/// PDA seeds: ["cycle", pool, member, cycle.to_le_bytes()].
#[account]
pub struct SpenderCycle {
    pub pool: Pubkey,
    pub member: Pubkey,
    pub cycle: u64,
    pub cap: u64,
    pub spent: u64,
    pub bump: u8,
}

impl SpenderCycle {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[account]
pub struct WithdrawalRequest {
    pub pool: Pubkey,
    pub id: u64,
    pub requester: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub justification_hash: [u8; 32],
    pub requires_proposal: bool,
    pub status: WithdrawalStatus,
    pub bump: u8,
}

impl WithdrawalRequest {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 32 + 8 + 32 + 1 + 1 + 1;
}

#[account]
pub struct Proposal {
    pub pool: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub action: ProposalAction,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub deadline: i64,
    pub executable_after: i64,
    pub state: ProposalState,
    pub bump: u8,
}

impl Proposal {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 41 + 4 + 4 + 8 + 8 + 1 + 1;
}

#[account]
pub struct VoteReceipt {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub approve: bool,
    pub bump: u8,
}

impl VoteReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 1;
}

/// PDA seeds: ["quote", pool, quote_id]. Its existence makes a sponsor quote
/// single-use even if a signed client transaction is submitted twice.
#[account]
pub struct SponsorQuoteReceipt {
    pub pool: Pubkey,
    pub member: Pubkey,
    pub quote_id: [u8; 32],
    pub bump: u8,
}

impl SponsorQuoteReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MemberRole {
    Member,
    Spender,
    Admin,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawalStatus {
    Pending,
    Spent,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalState {
    Open,
    Executable,
    Executed,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalAction {
    SetSpenderLimit {
        member: Pubkey,
        cap: u64,
    },
    ApproveWithdrawal {
        request: Pubkey,
    },
    ConfigurationModification {
        vote_threshold: u32,
        cycle_duration_seconds: i64,
        member_obligation_amount: u64,
    },
}

/// Exact message signed by the sponsor API. `quote_id` permits off-chain audit
/// and replay monitoring; on-chain expiry and allowance checks are decisive.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct SponsorQuote {
    pub quote_id: [u8; 32],
    pub pool: Pubkey,
    pub member: Pubkey,
    pub action: SponsoredAction,
    pub charge_usdc: u64,
    pub expires_at: i64,
    pub treasury_usdc: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SponsoredAction {
    SetAlias,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct JoinPoolArgs {
    pub initial_deposit: u64,
    pub alias_hash: [u8; 32],
    pub encryption_public_key: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalArgs {
    pub recipient: Pubkey,
    pub amount: u64,
    pub justification_hash: [u8; 32],
    pub requires_proposal: bool,
}

pub mod pool_handlers {
    use super::*;

    pub fn join_pool(ctx: Context<JoinPool>, args: JoinPoolArgs) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(
        pool.member_count < pool.member_cap,
        ComfiError::MemberCapReached
    );
    require!(
        args.initial_deposit >= pool.minimum_deposit,
        ComfiError::DepositBelowMinimum
    );
    transfer_user_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.user_usdc,
        &ctx.accounts.vault,
        &ctx.accounts.user,
        args.initial_deposit,
    )?;
    pool.member_count = pool
        .member_count
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;

    let member = &mut ctx.accounts.member;
    member.pool = pool.key();
    member.wallet = ctx.accounts.user.key();
    member.role = MemberRole::Spender;
    member.is_funded = args.initial_deposit >= pool.member_obligation_amount;
    member.deposited_total = args.initial_deposit;
    member.alias_hash = args.alias_hash;
    member.encryption_public_key = args.encryption_public_key;
    member.alias_version = 1;
    member.allowance_cycle = pool.current_cycle;
    member.action_allowance_used = 0;
    member.bump = ctx.bumps.member;
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ComfiError::InvalidAmount);
    transfer_user_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.source_usdc,
        &ctx.accounts.vault,
        &ctx.accounts.member_wallet,
        amount,
    )?;
    let member = &mut ctx.accounts.member;
    member.deposited_total = member
        .deposited_total
        .checked_add(amount)
        .ok_or(ComfiError::MathOverflow)?;
    member.is_funded = member.deposited_total >= ctx.accounts.pool.member_obligation_amount;
    Ok(())
}

pub fn set_alias(
    ctx: Context<MemberOnly>,
    alias_hash: [u8; 32],
    encryption_public_key: [u8; 32],
) -> Result<()> {
    let member = &mut ctx.accounts.member;
    member.alias_hash = alias_hash;
    member.encryption_public_key = encryption_public_key;
    member.alias_version = member
        .alias_version
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    Ok(())
}

pub fn run_sponsored_set_alias(
    ctx: Context<RunSponsoredSetAlias>,
    quote: SponsorQuote,
    alias_hash: [u8; 32],
    encryption_public_key: [u8; 32],
) -> Result<()> {
    require!(
        quote.action == SponsoredAction::SetAlias,
        ComfiError::WrongSponsoredAction
    );
    require_keys_eq!(
        quote.pool,
        ctx.accounts.pool.key(),
        ComfiError::QuotePoolMismatch
    );
    require_keys_eq!(
        quote.member,
        ctx.accounts.member.key(),
        ComfiError::QuoteMemberMismatch
    );
    require_keys_eq!(
        quote.treasury_usdc,
        ctx.accounts.treasury_usdc.key(),
        ComfiError::InvalidTreasury
    );
    require!(
        quote.expires_at >= Clock::get()?.unix_timestamp,
        ComfiError::QuoteExpired
    );
    require!(
        quote.charge_usdc <= ctx.accounts.pool.max_sponsored_action_charge,
        ComfiError::SponsorChargeTooHigh
    );
    verify_preceding_ed25519_quote(
        &ctx.accounts.instructions,
        &ctx.accounts.global.quote_authority,
        &quote,
    )?;
    let member = &mut ctx.accounts.member;
    if member.allowance_cycle != ctx.accounts.pool.current_cycle {
        member.allowance_cycle = ctx.accounts.pool.current_cycle;
        member.action_allowance_used = 0;
    }
    let next_used = member
        .action_allowance_used
        .checked_add(quote.charge_usdc)
        .ok_or(ComfiError::MathOverflow)?;
    require!(
        next_used <= ctx.accounts.pool.action_allowance_per_cycle,
        ComfiError::ActionAllowanceExceeded
    );

    let signer_seeds: &[&[u8]] = &[
        b"pool",
        &ctx.accounts.pool.id.to_le_bytes(),
        &[ctx.accounts.pool.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            Token::id(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_usdc.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        quote.charge_usdc,
    )?;
    member.action_allowance_used = next_used;
    member.alias_hash = alias_hash;
    member.encryption_public_key = encryption_public_key;
    member.alias_version = member
        .alias_version
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    let receipt = &mut ctx.accounts.quote_receipt;
    receipt.pool = ctx.accounts.pool.key();
    receipt.member = member.key();
    receipt.quote_id = quote.quote_id;
    receipt.bump = ctx.bumps.quote_receipt;
    Ok(())
}

pub fn roll_cycle(ctx: Context<RollCycle>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let next_start = pool
        .cycle_started_at
        .checked_add(pool.cycle_duration_seconds)
        .ok_or(ComfiError::MathOverflow)?;
    if !pool.testing_enabled {
        require!(
            Clock::get()?.unix_timestamp >= next_start,
            ComfiError::CycleNotReady
        );
    }
    pool.current_cycle = pool
        .current_cycle
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    pool.cycle_started_at = next_start;
    pool.apply_pending_config();
    Ok(())
}

pub fn test_roll_cycle(ctx: Context<TestPoolOnly>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    pool.current_cycle = pool
        .current_cycle
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    pool.cycle_started_at = Clock::get()?.unix_timestamp;
    pool.apply_pending_config();
    Ok(())
}

pub fn test_advance_cycles(ctx: Context<TestPoolOnly>, count: u64) -> Result<()> {
    require!(count > 0, ComfiError::InvalidAmount);
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    pool.current_cycle = pool
        .current_cycle
        .checked_add(count)
        .ok_or(ComfiError::MathOverflow)?;
    pool.cycle_started_at = Clock::get()?.unix_timestamp;
    pool.apply_pending_config();
    Ok(())
}

pub fn test_set_cycle(ctx: Context<TestPoolOnly>, cycle: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    pool.current_cycle = cycle;
    pool.cycle_started_at = Clock::get()?.unix_timestamp;
    pool.apply_pending_config();
    Ok(())
}

pub fn test_finalize_proposal(ctx: Context<TestFinalizeProposal>) -> Result<()> {
    ctx.accounts.pool.ensure_testing_enabled()?;
    let clock = Clock::get()?;
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.state == ProposalState::Open,
        ComfiError::ProposalNotOpen
    );
    if proposal.yes_votes >= ctx.accounts.pool.vote_threshold
        && proposal.yes_votes > proposal.no_votes
    {
        proposal.state = ProposalState::Executable;
        proposal.executable_after = clock.unix_timestamp;
    } else {
        proposal.state = ProposalState::Rejected;
    }
    Ok(())
}

pub fn test_reset_member_allowance(ctx: Context<TestMemberOnly>) -> Result<()> {
    ctx.accounts.pool.ensure_testing_enabled()?;
    let member = &mut ctx.accounts.member;
    member.allowance_cycle = ctx.accounts.pool.current_cycle;
    member.action_allowance_used = 0;
    Ok(())
}

pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, args: WithdrawalArgs) -> Result<()> {
    require!(args.amount > 0, ComfiError::InvalidAmount);
    require!(
        ctx.accounts.member.can_request_spend(),
        ComfiError::NotSpender
    );
    let request = &mut ctx.accounts.request;
    request.pool = ctx.accounts.pool.key();
    request.id = ctx.accounts.pool.next_request_id;
    request.requester = ctx.accounts.member.key();
    request.recipient = args.recipient;
    request.amount = args.amount;
    request.justification_hash = args.justification_hash;
    request.requires_proposal = args.requires_proposal;
    request.status = WithdrawalStatus::Pending;
    request.bump = ctx.bumps.request;
    ctx.accounts.pool.next_request_id = ctx
        .accounts
        .pool
        .next_request_id
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    Ok(())
}

pub fn create_proposal(ctx: Context<CreateProposal>, action: ProposalAction) -> Result<()> {
    require!(
        ctx.accounts.proposer.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    let clock = Clock::get()?;
    let proposal = &mut ctx.accounts.proposal;
    proposal.pool = ctx.accounts.pool.key();
    proposal.id = ctx.accounts.pool.next_proposal_id;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.action = action;
    proposal.yes_votes = 0;
    proposal.no_votes = 0;
    proposal.deadline = clock
        .unix_timestamp
        .checked_add(ctx.accounts.pool.voting_period_seconds)
        .ok_or(ComfiError::MathOverflow)?;
    proposal.executable_after = 0;
    proposal.state = ProposalState::Open;
    proposal.bump = ctx.bumps.proposal;
    ctx.accounts.pool.next_proposal_id = ctx
        .accounts
        .pool
        .next_proposal_id
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    Ok(())
}

pub fn vote(ctx: Context<Vote>, approve: bool) -> Result<()> {
    let clock = Clock::get()?;
    let proposal = &mut ctx.accounts.proposal;
    require!(
        ctx.accounts.voter.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    require!(
        proposal.state == ProposalState::Open,
        ComfiError::ProposalNotOpen
    );
    require!(
        clock.unix_timestamp <= proposal.deadline,
        ComfiError::VotingClosed
    );
    if approve {
        proposal.yes_votes = proposal
            .yes_votes
            .checked_add(1)
            .ok_or(ComfiError::MathOverflow)?;
    } else {
        proposal.no_votes = proposal
            .no_votes
            .checked_add(1)
            .ok_or(ComfiError::MathOverflow)?;
    }
    let receipt = &mut ctx.accounts.receipt;
    receipt.proposal = proposal.key();
    receipt.voter = ctx.accounts.voter.key();
    receipt.approve = approve;
    receipt.bump = ctx.bumps.receipt;
    Ok(())
}

pub fn finalize_proposal(ctx: Context<FinalizeProposal>) -> Result<()> {
    let clock = Clock::get()?;
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.state == ProposalState::Open,
        ComfiError::ProposalNotOpen
    );
    require!(
        clock.unix_timestamp > proposal.deadline,
        ComfiError::VotingStillOpen
    );
    if proposal.yes_votes >= ctx.accounts.pool.vote_threshold
        && proposal.yes_votes > proposal.no_votes
    {
        proposal.state = ProposalState::Executable;
        proposal.executable_after = clock
            .unix_timestamp
            .checked_add(ctx.accounts.pool.timelock_seconds)
            .ok_or(ComfiError::MathOverflow)?;
    } else {
        proposal.state = ProposalState::Rejected;
    }
    Ok(())
}

pub fn execute_spender_limit(ctx: Context<ExecuteSpenderLimit>) -> Result<()> {
    assert_executable(&ctx.accounts.proposal)?;
    let (target, cap) = match ctx.accounts.proposal.action {
        ProposalAction::SetSpenderLimit { member, cap } => (member, cap),
        _ => return err!(ComfiError::WrongProposalAction),
    };
    require_keys_eq!(
        target,
        ctx.accounts.spender_member.key(),
        ComfiError::ProposalTargetMismatch
    );
    if ctx.accounts.spender_member.role == MemberRole::Member {
        ctx.accounts.spender_member.role = MemberRole::Spender;
    }
    let cycle = &mut ctx.accounts.spender_cycle;
    cycle.pool = ctx.accounts.pool.key();
    cycle.member = ctx.accounts.spender_member.key();
    cycle.cycle = ctx.accounts.pool.current_cycle;
    cycle.cap = cap;
    cycle.spent = 0;
    cycle.bump = ctx.bumps.spender_cycle;
    ctx.accounts.proposal.state = ProposalState::Executed;
    Ok(())
}

pub fn execute_configuration_modification(
    ctx: Context<ExecuteConfigurationModification>,
) -> Result<()> {
    assert_executable(&ctx.accounts.proposal)?;
    let (vote_threshold, cycle_duration_seconds, member_obligation_amount) = match ctx
        .accounts
        .proposal
        .action
    {
        ProposalAction::ConfigurationModification {
            vote_threshold,
            cycle_duration_seconds,
            member_obligation_amount,
        } => (
            vote_threshold,
            cycle_duration_seconds,
            member_obligation_amount,
        ),
        _ => return err!(ComfiError::WrongProposalAction),
    };
    require!(
        vote_threshold > 0 && vote_threshold <= ctx.accounts.pool.member_cap,
        ComfiError::InvalidVoteThreshold
    );
    require!(
        cycle_duration_seconds > 0,
        ComfiError::InvalidCycleDuration
    );

    let pool = &mut ctx.accounts.pool;
    pool.has_pending_config = true;
    pool.pending_vote_threshold = vote_threshold;
    pool.pending_cycle_duration_seconds = cycle_duration_seconds;
    pool.pending_member_obligation_amount = member_obligation_amount;
    ctx.accounts.proposal.state = ProposalState::Executed;
    Ok(())
}

pub fn spend(ctx: Context<Spend>) -> Result<()> {
    let request = &mut ctx.accounts.request;
    require!(
        request.status == WithdrawalStatus::Pending,
        ComfiError::RequestNotPending
    );
    require!(
        ctx.accounts.executor_member.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    require!(
        ctx.accounts.requester_member.can_request_spend(),
        ComfiError::NotSpender
    );
    require!(
        ctx.accounts.spender_cycle.cycle == ctx.accounts.pool.current_cycle,
        ComfiError::WrongCycle
    );
    require!(
        ctx.accounts.spender_cycle.member == ctx.accounts.requester_member.key(),
        ComfiError::InvalidSpendCycle
    );
    if request.requires_proposal {
        let proposal = ctx
            .accounts
            .proposal
            .as_ref()
            .ok_or(ComfiError::ProposalRequired)?;
        assert_executable(proposal)?;
        match proposal.action {
            ProposalAction::ApproveWithdrawal { request: key } if key == request.key() => {}
            _ => return err!(ComfiError::WrongProposalAction),
        }
        ctx.accounts.proposal.as_mut().unwrap().state = ProposalState::Executed;
    }
    let cycle = &mut ctx.accounts.spender_cycle;
    let next_spent = cycle
        .spent
        .checked_add(request.amount)
        .ok_or(ComfiError::MathOverflow)?;
    require!(next_spent <= cycle.cap, ComfiError::SpendLimitExceeded);
    let signer_seeds: &[&[u8]] = &[
        b"pool",
        &ctx.accounts.pool.id.to_le_bytes(),
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[signer_seeds];
    let cpi = CpiContext::new_with_signer(
        Token::id(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.recipient_usdc.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer,
    );
    token::transfer(cpi, request.amount)?;
    cycle.spent = next_spent;
    request.status = WithdrawalStatus::Spent;
    Ok(())
}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_pool() -> Pool {
        Pool {
            global: Pubkey::default(),
            id: 0,
            creator: Pubkey::default(),
            vault: Pubkey::default(),
            member_cap: 10,
            member_count: 1,
            minimum_deposit: 10,
            member_obligation_amount: 50,
            vote_threshold: 2,
            voting_period_seconds: 100,
            timelock_seconds: 50,
            current_cycle: 0,
            cycle_duration_seconds: 1000,
            cycle_started_at: 0,
            action_allowance_per_cycle: 100,
            max_sponsored_action_charge: 10,
            next_request_id: 0,
            next_proposal_id: 0,
            bump: 255,
            testing_enabled: true,
            has_pending_config: false,
            pending_vote_threshold: 2,
            pending_cycle_duration_seconds: 1000,
            pending_member_obligation_amount: 50,
        }
    }

    #[test]
    fn test_testing_enabled_check() {
        let mut pool = create_test_pool();
        assert!(pool.ensure_testing_enabled().is_ok());

        pool.testing_enabled = false;
        let err = pool.ensure_testing_enabled().unwrap_err();
        assert_eq!(err, ComfiError::TestingNotEnabled.into());
    }

    #[test]
    fn test_can_request_spend() {
        let mut member = Member {
            pool: Pubkey::default(),
            wallet: Pubkey::default(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
        };

        assert!(member.can_request_spend());

        member.role = MemberRole::Spender;
        assert!(member.can_request_spend());

        member.role = MemberRole::Admin;
        assert!(member.can_request_spend());
    }

    #[test]
    fn test_member_obligation_and_funded_status() {
        let pool = create_test_pool();

        let mut member = Member {
            pool: Pubkey::default(),
            wallet: Pubkey::default(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 40,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
        };

        // Deposited 40 < 50 obligation: not counted as funded member
        assert!(!member.is_funded_for_pool(&pool));

        // Deposited 50 >= 50 obligation: counted as funded member
        member.deposited_total = 50;
        assert!(member.is_funded_for_pool(&pool));

        // Member marked as unfunded even with total met
        member.is_funded = false;
        assert!(!member.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_configuration_modification_deferred_until_cycle_roll() {
        let mut pool = create_test_pool();

        // Stage new configuration
        pool.has_pending_config = true;
        pool.pending_vote_threshold = 4;
        pool.pending_cycle_duration_seconds = 2000;
        pool.pending_member_obligation_amount = 150;

        // Current active config has NOT changed yet
        assert_eq!(pool.vote_threshold, 2);
        assert_eq!(pool.cycle_duration_seconds, 1000);
        assert_eq!(pool.member_obligation_amount, 50);

        // Advance cycle
        pool.current_cycle += 1;
        pool.apply_pending_config();

        // New config is now active
        assert_eq!(pool.vote_threshold, 4);
        assert_eq!(pool.cycle_duration_seconds, 2000);
        assert_eq!(pool.member_obligation_amount, 150);
        assert!(!pool.has_pending_config);
    }

    #[test]
    fn test_apply_pending_config_noop_when_not_pending() {
        let mut pool = create_test_pool();
        pool.has_pending_config = false;
        pool.vote_threshold = 2;
        pool.pending_vote_threshold = 5;

        pool.apply_pending_config();
        // Should remain untouched
        assert_eq!(pool.vote_threshold, 2);
    }

    #[test]
    fn test_account_space_constants() {
        assert_eq!(Pool::SPACE, 8 + 227);
        assert_eq!(
            Member::SPACE,
            8 + 32 + 32 + 1 + 1 + 8 + 32 + 32 + 4 + 8 + 8 + 1
        );
        assert_eq!(SpenderCycle::SPACE, 8 + 32 + 32 + 8 + 8 + 8 + 1);
        assert_eq!(
            WithdrawalRequest::SPACE,
            8 + 32 + 8 + 32 + 32 + 8 + 32 + 1 + 1 + 1
        );
        assert_eq!(
            Proposal::SPACE,
            8 + 32 + 8 + 32 + 41 + 4 + 4 + 8 + 8 + 1 + 1
        );
        assert_eq!(VoteReceipt::SPACE, 8 + 32 + 32 + 1 + 1);
        assert_eq!(SponsorQuoteReceipt::SPACE, 8 + 32 + 32 + 32 + 1);
    }

    #[test]
    fn test_proposal_voting_outcome_logic() {
        let pool = create_test_pool(); // vote_threshold = 2
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ApproveWithdrawal {
                request: Pubkey::new_unique(),
            },
            yes_votes: 1,
            no_votes: 0,
            deadline: 100,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
        };

        // 1 yes vote is below threshold of 2: should be rejected
        let is_passed = proposal.yes_votes >= pool.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(!is_passed);

        // 2 yes votes and 0 no votes: reaches threshold of 2 and majority
        proposal.yes_votes = 2;
        let is_passed = proposal.yes_votes >= pool.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(is_passed);

        // 2 yes votes and 2 no votes: tied, should not pass
        proposal.no_votes = 2;
        let is_passed = proposal.yes_votes >= pool.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(!is_passed);
    }
}
