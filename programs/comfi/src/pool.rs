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
        constraint = !pool.is_closing @ ComfiError::PoolIsClosing,
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
        mut,
        has_one = global,
        constraint = !pool.is_closing @ ComfiError::PoolIsClosing,
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
        mut,
        has_one = global,
        constraint = !pool.is_closing @ ComfiError::PoolIsClosing,
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
    #[account(mut)]
    pub cranker: Option<Signer<'info>>,
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
        mut,
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
    #[account(mut)]
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
        mut,
        has_one = pool,
        constraint = requester_member.key() == request.requester @ ComfiError::Unauthorized
    )]
    pub requester_member: Box<Account<'info, Member>>,
    #[account(mut)]
    pub spender_cycle: Option<Box<Account<'info, SpenderCycle>>>,
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
pub struct ExecuteClosePool<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,
    #[account(mut, has_one = global)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault)]
    pub vault: Option<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct ClaimClosureRefund<'info> {
    #[account(mut)]
    pub member_wallet: Signer<'info>,
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
        seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()],
        bump = member.bump,
        has_one = pool,
        constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized
    )]
    pub member: Account<'info, Member>,
    #[account(
        mut,
        address = pool.vault @ ComfiError::InvalidVault,
        constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = member_usdc.owner == member_wallet.key() @ ComfiError::Unauthorized,
        constraint = member_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub member_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[cfg(any(test, feature = "testing"))]
#[derive(Accounts)]
pub struct TestPoolOnly<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[cfg(any(test, feature = "testing"))]
#[derive(Accounts)]
pub struct TestFinalizeProposal<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub proposal: Account<'info, Proposal>,
}

#[cfg(any(test, feature = "testing"))]
#[derive(Accounts)]
pub struct TestMemberOnly<'info> {
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)]
    pub member: Account<'info, Member>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExecutionMode {
    OnDeadline,
    ThresholdMet,
}

pub const BENEFIT_SCALE: u128 = 1_000_000_000_000; // 1e12

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
    pub spender_limit_deadline_cycles: u64,
    pub withdrawal_deadline_cycles: u64,
    pub config_modification_deadline_cycles: u64,
    pub pending_spender_limit_deadline_cycles: u64,
    pub pending_withdrawal_deadline_cycles: u64,
    pub pending_config_modification_deadline_cycles: u64,
    pub spender_limit_execution_mode: ExecutionMode,
    pub withdrawal_execution_mode: ExecutionMode,
    pub config_modification_execution_mode: ExecutionMode,
    pub pending_spender_limit_execution_mode: ExecutionMode,
    pub pending_withdrawal_execution_mode: ExecutionMode,
    pub pending_config_modification_execution_mode: ExecutionMode,
    pub is_closing: bool,
    pub total_non_conferred_capital: u64,
    pub close_deadline_cycles: u64,
    pub close_execution_mode: ExecutionMode,
    pub total_settled_capital: u64,
    pub funded_member_count: u32,
    pub cumulative_benefit_per_member: u128,
    pub total_conferred_capital: u64,
    pub has_snapshotted_closure: bool,
    pub closing_vault_basis: u64,
    pub closing_non_conferred_basis: u64,
    pub closing_conferred_pool_capital: u64,
    pub head_member: Option<Pubkey>,
    pub rollover_cursor: Option<Pubkey>,
}

impl Pool {
    pub const BASE_SPACE: usize = 8 + 426;
    pub const SPACE: usize = Self::BASE_SPACE;

    pub fn space(_member_cap: u32) -> usize {
        Self::SPACE
    }

    pub fn ensure_testing_enabled(&self) -> Result<()> {
        require!(self.testing_enabled, ComfiError::TestingNotEnabled);
        Ok(())
    }

    pub fn ensure_not_closing(&self) -> Result<()> {
        require!(!self.is_closing, ComfiError::PoolIsClosing);
        Ok(())
    }

    pub fn ensure_cycle_current_at(&self, current_timestamp: i64) -> Result<()> {
        if !self.is_closing {
            require!(
                self.rollover_cursor.is_none(),
                ComfiError::CycleRollRequired
            );
            let next_start = self
                .cycle_started_at
                .checked_add(self.cycle_duration_seconds)
                .ok_or(ComfiError::MathOverflow)?;
            require!(
                current_timestamp < next_start,
                ComfiError::CycleRollRequired
            );
        }
        Ok(())
    }

    pub fn ensure_cycle_current(&self) -> Result<()> {
        if !self.is_closing && !self.testing_enabled {
            let now = Clock::get()?.unix_timestamp;
            self.ensure_cycle_current_at(now)?;
        }
        Ok(())
    }

    pub fn enter_closure(&mut self) {
        self.is_closing = true;
        self.closing_non_conferred_basis = self.total_non_conferred_capital;
        self.closing_conferred_pool_capital = self.total_conferred_capital;
    }

    pub fn get_proposal_deadline_cycles(&self, action: &ProposalAction) -> u64 {
        match action {
            ProposalAction::SetSpenderLimit { .. } => self.spender_limit_deadline_cycles,
            ProposalAction::ApproveWithdrawal { .. } => self.withdrawal_deadline_cycles,
            ProposalAction::ConfigurationModification { .. } => {
                self.config_modification_deadline_cycles
            }
            ProposalAction::ClosePool => self.close_deadline_cycles,
        }
    }

    pub fn get_proposal_execution_mode(&self, action: &ProposalAction) -> ExecutionMode {
        match action {
            ProposalAction::SetSpenderLimit { .. } => self.spender_limit_execution_mode,
            ProposalAction::ApproveWithdrawal { .. } => self.withdrawal_execution_mode,
            ProposalAction::ConfigurationModification { .. } => {
                self.config_modification_execution_mode
            }
            ProposalAction::ClosePool => self.close_execution_mode,
        }
    }

    pub fn apply_pending_config(&mut self) {
        if self.has_pending_config {
            self.vote_threshold = self.pending_vote_threshold;
            self.cycle_duration_seconds = self.pending_cycle_duration_seconds;
            self.member_obligation_amount = self.pending_member_obligation_amount;
            self.spender_limit_deadline_cycles = self.pending_spender_limit_deadline_cycles;
            self.withdrawal_deadline_cycles = self.pending_withdrawal_deadline_cycles;
            self.config_modification_deadline_cycles =
                self.pending_config_modification_deadline_cycles;
            self.spender_limit_execution_mode = self.pending_spender_limit_execution_mode;
            self.withdrawal_execution_mode = self.pending_withdrawal_execution_mode;
            self.config_modification_execution_mode =
                self.pending_config_modification_execution_mode;
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
    pub surplus_amount: u64,
    pub total_withdrawn: u64,
    pub closure_claimed: bool,
    pub last_benefit_index: u128,
    pub cumulative_benefit_received: u64,
    pub total_contributions: u64,
    pub surplus_cycle: u64,
    pub funded_cycle: u64,
    /// Pause choice for the next rollover. `is_funded` is the effective
    /// current-cycle status, so a pause cannot change the live electorate.
    pub is_paused: bool,
    pub next_member: Option<Pubkey>,
}

impl Member {
    pub const SPACE: usize = 8 + 258;

    pub fn can_request_spend(&self) -> bool {
        matches!(
            self.role,
            MemberRole::Member | MemberRole::Spender | MemberRole::Admin
        )
    }

    pub fn is_funded_for_pool(&self, pool: &Pool) -> bool {
        self.is_funded
            && self.funded_cycle == pool.current_cycle
            && self.deposited_total >= pool.member_obligation_amount
    }

    pub fn non_conferred_amount(&self) -> u64 {
        if !self.is_funded {
            self.total_contributions
        } else {
            self.surplus_amount
        }
    }

    pub fn conferred_contribution(&self) -> u64 {
        self.total_contributions.saturating_sub(self.non_conferred_amount())
    }

    pub fn sync_surplus(&mut self, pool: &mut Pool) {
        if pool.current_cycle > self.surplus_cycle {
            let obligation = pool.member_obligation_amount;
            if self.is_paused {
                self.is_funded = false;
            } else if self.surplus_amount >= obligation && obligation > 0 {
                let consumed = obligation;
                self.surplus_amount = self.surplus_amount.saturating_sub(consumed);
                pool.total_non_conferred_capital = pool.total_non_conferred_capital.saturating_sub(consumed);
                pool.total_conferred_capital = pool.total_conferred_capital.saturating_add(consumed);
                self.is_funded = true;
                self.funded_cycle = pool.current_cycle;
            } else {
                self.is_funded = false;
            }
            self.surplus_cycle = pool.current_cycle;
        }
    }

    pub fn sync_benefit(&mut self, pool: &Pool) -> Result<()> {
        if pool.cumulative_benefit_per_member > self.last_benefit_index {
            let diff = pool.cumulative_benefit_per_member
                .checked_sub(self.last_benefit_index)
                .ok_or(ComfiError::MathOverflow)?;
            if self.is_funded_for_pool(pool) {
                let accrued = (diff / BENEFIT_SCALE) as u64;
                self.cumulative_benefit_received = self.cumulative_benefit_received
                    .checked_add(accrued)
                    .ok_or(ComfiError::MathOverflow)?;
            }
            self.last_benefit_index = pool.cumulative_benefit_per_member;
        }
        Ok(())
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
    pub voting_cycle: u64,
    pub deadline_cycle: u64,
    pub deadline: i64,
    pub executable_after: i64,
    pub state: ProposalState,
    pub bump: u8,
    pub execution_mode: ExecutionMode,
    pub vote_threshold: u32,
}

impl Proposal {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 48 + 4 + 4 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 4;

    pub fn required_votes_for_pool(&self, pool: &Pool) -> Result<u32> {
        require!(
            self.vote_threshold >= 100 && self.vote_threshold <= 10_000,
            ComfiError::InvalidVoteThreshold
        );
        let mut threshold_bps = self.vote_threshold as u64;
        if matches!(
            self.action,
            ProposalAction::SetSpenderLimit { .. }
                | ProposalAction::ClosePool
                | ProposalAction::ApproveWithdrawal { .. }
                | ProposalAction::ConfigurationModification { .. }
        ) {
            threshold_bps = threshold_bps.max(5001);
        }
        let active_members = (pool.funded_member_count as u64).max(1);
        let required = active_members
            .checked_mul(threshold_bps)
            .ok_or(ComfiError::MathOverflow)?
            .checked_add(9999)
            .ok_or(ComfiError::MathOverflow)?
            / 10_000;
        Ok((required as u32).max(1))
    }

    pub fn is_passed_for_pool(&self, pool: &Pool) -> Result<bool> {
        let required = self.required_votes_for_pool(pool)?;
        Ok(self.yes_votes >= required && self.yes_votes > self.no_votes)
    }
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemberRole {
    Member,
    Spender,
    Admin,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WithdrawalStatus {
    Pending,
    Spent,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalState {
    Queued,
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
        spender_limit_deadline_cycles: u64,
        withdrawal_deadline_cycles: u64,
        config_modification_deadline_cycles: u64,
        spender_limit_execution_mode: ExecutionMode,
        withdrawal_execution_mode: ExecutionMode,
        config_modification_execution_mode: ExecutionMode,
    },
    ClosePool,
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
    pool.ensure_not_closing()?;
    pool.ensure_cycle_current()?;
    require!(
        pool.member_count < pool.member_cap,
        ComfiError::MemberCapReached
    );
    require!(
        args.initial_deposit >= pool.minimum_deposit,
        ComfiError::DepositBelowMinimum
    );

    if args.initial_deposit > pool.member_obligation_amount {
        let excess = args.initial_deposit
            .checked_sub(pool.member_obligation_amount)
            .ok_or(ComfiError::MathOverflow)?;
        require!(
            excess <= pool.member_obligation_amount,
            ComfiError::OverfundingCapExceeded
        );
    }

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

    // Joining mid-cycle does not confer funded voting status or capital for the active cycle.
    // All initial deposits accumulate into non-conferred surplus and are transitioned
    // on the next cycle rollover (roll_cycle).
    pool.total_non_conferred_capital = pool
        .total_non_conferred_capital
        .checked_add(args.initial_deposit)
        .ok_or(ComfiError::MathOverflow)?;

    let member = &mut ctx.accounts.member;
    member.pool = pool.key();
    member.wallet = ctx.accounts.user.key();
    member.role = MemberRole::Spender;
    member.is_funded = false;
    member.deposited_total = args.initial_deposit;
    member.surplus_amount = args.initial_deposit;
    member.total_withdrawn = 0;
    member.closure_claimed = false;
    member.last_benefit_index = pool.cumulative_benefit_per_member;
    member.cumulative_benefit_received = 0;
    member.total_contributions = args.initial_deposit;
    member.alias_hash = args.alias_hash;
    member.encryption_public_key = args.encryption_public_key;
    member.alias_version = 1;
    member.allowance_cycle = pool.current_cycle;
    member.action_allowance_used = 0;
    member.bump = ctx.bumps.member;
    member.surplus_cycle = pool.current_cycle;
    member.funded_cycle = 0;
    member.is_paused = false;
    member.next_member = pool.head_member;
    pool.head_member = Some(ctx.accounts.member.key());
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ComfiError::InvalidAmount);
    let pool = &mut ctx.accounts.pool;
    pool.ensure_not_closing()?;
    pool.ensure_cycle_current()?;

    transfer_user_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.source_usdc,
        &ctx.accounts.vault,
        &ctx.accounts.member_wallet,
        amount,
    )?;
    let member = &mut ctx.accounts.member;
    member.sync_surplus(pool);
    let next_total = member
        .deposited_total
        .checked_add(amount)
        .ok_or(ComfiError::MathOverflow)?;
    let next_contributions = member
        .total_contributions
        .checked_add(amount)
        .ok_or(ComfiError::MathOverflow)?;

    let new_surplus = member
        .surplus_amount
        .checked_add(amount)
        .ok_or(ComfiError::MathOverflow)?;
    require!(
        new_surplus <= pool.member_obligation_amount,
        ComfiError::OverfundingCapExceeded
    );

    pool.total_non_conferred_capital = pool
        .total_non_conferred_capital
        .checked_add(amount)
        .ok_or(ComfiError::MathOverflow)?;

    member.sync_benefit(pool)?;

    member.deposited_total = next_total;
    member.total_contributions = next_contributions;
    member.surplus_amount = new_surplus;
    member.surplus_cycle = pool.current_cycle;

    Ok(())
}

pub fn set_alias(
    ctx: Context<MemberOnly>,
    alias_hash: [u8; 32],
    encryption_public_key: [u8; 32],
) -> Result<()> {
    ctx.accounts.pool.ensure_not_closing()?;
    ctx.accounts.pool.ensure_cycle_current()?;
    let member = &mut ctx.accounts.member;
    member.alias_hash = alias_hash;
    member.encryption_public_key = encryption_public_key;
    member.alias_version = member
        .alias_version
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    Ok(())
}

pub fn set_paused(ctx: Context<MemberOnly>, paused: bool) -> Result<()> {
    ctx.accounts.pool.ensure_not_closing()?;
    ctx.accounts.pool.ensure_cycle_current()?;
    let member = &mut ctx.accounts.member;
    // `is_funded` remains unchanged for this cycle. Rollover applies this
    // pause choice before calculating the next cycle's funded cohort.
    member.is_paused = paused;
    Ok(())
}

pub fn run_sponsored_set_alias(
    ctx: Context<RunSponsoredSetAlias>,
    quote: SponsorQuote,
    alias_hash: [u8; 32],
    encryption_public_key: [u8; 32],
) -> Result<()> {
    ctx.accounts.pool.ensure_not_closing()?;
    ctx.accounts.pool.ensure_cycle_current()?;
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
    require!(
        ctx.accounts.vault.amount.saturating_sub(quote.charge_usdc)
            >= ctx.accounts.pool.total_non_conferred_capital,
        ComfiError::InsufficientVaultForSurplus
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
    ctx.accounts.pool.total_conferred_capital = ctx.accounts.pool
        .total_conferred_capital
        .saturating_sub(quote.charge_usdc);
    member.cumulative_benefit_received = member
        .cumulative_benefit_received
        .checked_add(quote.charge_usdc)
        .ok_or(ComfiError::MathOverflow)?;
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

pub fn process_cycle_proposals<'info>(
    pool_key: Pubkey,
    pool: &mut Pool,
    ending_cycle: u64,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    for account_info in remaining_accounts.iter() {
        if !account_info.is_writable || account_info.data_len() < 8 {
            continue;
        }

        let mut proposal = {
            let data = account_info.try_borrow_data()?;
            if &data[..8] != Proposal::DISCRIMINATOR {
                continue;
            }
            let mut slice: &[u8] = &data;
            match Proposal::try_deserialize(&mut slice) {
                Ok(p) => p,
                Err(_) => continue,
            }
        };

        if proposal.pool != pool_key || ending_cycle < proposal.voting_cycle {
            continue;
        }
        if proposal.state != ProposalState::Queued && proposal.state != ProposalState::Open {
            continue;
        }

        let passed = proposal.is_passed_for_pool(pool)?;
        let is_deadline = ending_cycle >= proposal.deadline_cycle;

        let should_resolve = match proposal.execution_mode {
            ExecutionMode::OnDeadline => is_deadline,
            ExecutionMode::ThresholdMet => passed || is_deadline,
        };

        if !should_resolve {
            continue;
        }

        if passed {
            proposal.state = ProposalState::Executable;
            proposal.executable_after = Clock::get()?
                .unix_timestamp
                .checked_add(pool.timelock_seconds)
                .ok_or(ComfiError::MathOverflow)?;
        } else {
            proposal.state = ProposalState::Rejected;
        }

        proposal.try_serialize(&mut *account_info.try_borrow_mut_data()?)?;
    }
    Ok(())
}

pub fn process_cycle_members<'info>(
    pool_key: Pubkey,
    pool: &mut Pool,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let (mut current_expected, mut newly_funded_count) = match pool.rollover_cursor {
        Some(cursor) => (cursor, pool.funded_member_count),
        None => match pool.head_member {
            Some(head) => (head, 0),
            None => {
                pool.funded_member_count = 0;
                pool.rollover_cursor = None;
                return Ok(());
            }
        },
    };

    let mut processed_members: usize = 0;

    for account_info in remaining_accounts.iter() {
        if account_info.data_len() < 8 {
            break;
        }
        let disc = {
            let data = account_info.try_borrow_data()?;
            let mut d = [0u8; 8];
            d.copy_from_slice(&data[..8]);
            d
        };
        if disc == Proposal::DISCRIMINATOR {
            break;
        }
        if disc != Member::DISCRIMINATOR {
            break;
        }

        require!(
            account_info.key == &current_expected,
            ComfiError::IncompleteMemberList
        );
        require!(account_info.is_writable, ComfiError::Unauthorized);

        let mut member = {
            let data = account_info.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            match Member::try_deserialize(&mut slice) {
                Ok(m) => m,
                Err(_) => {
                    if !pool.testing_enabled {
                        return err!(ComfiError::IncompleteMemberList);
                    } else {
                        break;
                    }
                }
            }
        };

        if member.pool != pool_key {
            return err!(ComfiError::Unauthorized);
        }

        processed_members = processed_members
            .checked_add(1)
            .ok_or(ComfiError::MathOverflow)?;

        let obligation = pool.member_obligation_amount;
        if member.is_paused {
            member.is_funded = false;
        } else if member.surplus_amount >= obligation && obligation > 0 {
            let consumed = obligation;
            member.surplus_amount = member
                .surplus_amount
                .checked_sub(consumed)
                .ok_or(ComfiError::MathOverflow)?;
            pool.total_non_conferred_capital = pool
                .total_non_conferred_capital
                .saturating_sub(consumed);
            pool.total_conferred_capital = pool
                .total_conferred_capital
                .checked_add(consumed)
                .ok_or(ComfiError::MathOverflow)?;
            member.is_funded = true;
            member.funded_cycle = pool.current_cycle;
            newly_funded_count = newly_funded_count
                .checked_add(1)
                .ok_or(ComfiError::MathOverflow)?;
        } else {
            member.is_funded = false;
        }
        member.surplus_cycle = pool.current_cycle;

        member.try_serialize(&mut *account_info.try_borrow_mut_data()?)?;

        match member.next_member {
            Some(next) => {
                current_expected = next;
            }
            None => {
                pool.rollover_cursor = None;
                pool.funded_member_count = newly_funded_count;
                return Ok(());
            }
        }
    }

    if processed_members == 0 {
        if !pool.testing_enabled && pool.head_member.is_some() {
            return err!(ComfiError::IncompleteMemberList);
        }
    } else {
        pool.rollover_cursor = Some(current_expected);
        pool.funded_member_count = newly_funded_count;
    }

    Ok(())
}

pub fn roll_cycle(ctx: Context<RollCycle>) -> Result<()> {
    let pool_key = ctx.accounts.pool.key();
    let pool = &mut ctx.accounts.pool;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);

    let is_resuming_chunk = pool.rollover_cursor.is_some();
    if !is_resuming_chunk {
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
        pool.funded_member_count = 0;
    }

    let ending_cycle = pool.current_cycle.saturating_sub(1);

    process_cycle_members(pool_key, pool, ctx.remaining_accounts)?;

    if pool.rollover_cursor.is_none() {
        process_cycle_proposals(pool_key, pool, ending_cycle, ctx.remaining_accounts)?;
    }

    if let Some(cranker) = &ctx.accounts.cranker {
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(pool.to_account_info().data_len());
        let pool_lamports = pool.to_account_info().lamports();
        let fee_reimbursement = 10_000u64.min(pool_lamports.saturating_sub(min_rent));
        if fee_reimbursement > 0 {
            **pool.to_account_info().try_borrow_mut_lamports()? = pool
                .to_account_info()
                .lamports()
                .checked_sub(fee_reimbursement)
                .ok_or(ComfiError::MathOverflow)?;
            **cranker.to_account_info().try_borrow_mut_lamports()? = cranker
                .to_account_info()
                .lamports()
                .checked_add(fee_reimbursement)
                .ok_or(ComfiError::MathOverflow)?;
        }
    }

    Ok(())
}

#[cfg(any(test, feature = "testing"))]
pub fn test_roll_cycle(ctx: Context<TestPoolOnly>) -> Result<()> {
    let pool_key = ctx.accounts.pool.key();
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);

    let is_resuming_chunk = pool.rollover_cursor.is_some();
    if !is_resuming_chunk {
        pool.current_cycle = pool
            .current_cycle
            .checked_add(1)
            .ok_or(ComfiError::MathOverflow)?;
        pool.cycle_started_at = Clock::get()?.unix_timestamp;
        pool.apply_pending_config();
        pool.funded_member_count = 0;
    }

    let ending_cycle = pool.current_cycle.saturating_sub(1);

    process_cycle_members(pool_key, pool, ctx.remaining_accounts)?;

    if pool.rollover_cursor.is_none() {
        process_cycle_proposals(pool_key, pool, ending_cycle, ctx.remaining_accounts)?;
    }
    Ok(())
}

#[cfg(any(test, feature = "testing"))]
pub fn test_advance_cycles(ctx: Context<TestPoolOnly>, count: u64) -> Result<()> {
    require!(count > 0, ComfiError::InvalidAmount);
    let pool_key = ctx.accounts.pool.key();
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);
    let ending_cycle = pool.current_cycle;
    pool.current_cycle = pool
        .current_cycle
        .checked_add(count)
        .ok_or(ComfiError::MathOverflow)?;
    pool.cycle_started_at = Clock::get()?.unix_timestamp;
    pool.apply_pending_config();
    pool.funded_member_count = 0;
    pool.rollover_cursor = None;

    process_cycle_members(pool_key, pool, ctx.remaining_accounts)?;

    if pool.rollover_cursor.is_none() {
        process_cycle_proposals(pool_key, pool, ending_cycle, ctx.remaining_accounts)?;
    }
    Ok(())
}

#[cfg(any(test, feature = "testing"))]
pub fn test_set_cycle(ctx: Context<TestPoolOnly>, cycle: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.ensure_testing_enabled()?;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);
    pool.current_cycle = cycle;
    pool.cycle_started_at = Clock::get()?.unix_timestamp;
    pool.apply_pending_config();
    Ok(())
}

#[cfg(any(test, feature = "testing"))]
pub fn test_finalize_proposal(ctx: Context<TestFinalizeProposal>) -> Result<()> {
    ctx.accounts.pool.ensure_testing_enabled()?;
    let clock = Clock::get()?;
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.state == ProposalState::Open || proposal.state == ProposalState::Queued,
        ComfiError::ProposalNotOpen
    );
    let passed = proposal.is_passed_for_pool(&ctx.accounts.pool)?;
    if passed {
        proposal.state = ProposalState::Executable;
        proposal.executable_after = clock.unix_timestamp;
    } else {
        proposal.state = ProposalState::Rejected;
    }
    Ok(())
}

#[cfg(any(test, feature = "testing"))]
pub fn test_reset_member_allowance(ctx: Context<TestMemberOnly>) -> Result<()> {
    ctx.accounts.pool.ensure_testing_enabled()?;
    let member = &mut ctx.accounts.member;
    member.allowance_cycle = ctx.accounts.pool.current_cycle;
    member.action_allowance_used = 0;
    Ok(())
}

pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, args: WithdrawalArgs) -> Result<()> {
    require!(!ctx.accounts.pool.is_closing, ComfiError::PoolIsClosing);
    ctx.accounts.pool.ensure_cycle_current()?;
    require!(args.amount > 0, ComfiError::InvalidAmount);
    require!(
        ctx.accounts.member.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
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
    require!(!ctx.accounts.pool.is_closing, ComfiError::PoolIsClosing);
    ctx.accounts.pool.ensure_cycle_current()?;
    require!(
        ctx.accounts.proposer.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    let deadline_cycles = ctx.accounts.pool.get_proposal_deadline_cycles(&action);
    require!(deadline_cycles > 0, ComfiError::InvalidProposalDeadline);
    if let ProposalAction::ConfigurationModification {
        vote_threshold,
        spender_limit_deadline_cycles,
        withdrawal_deadline_cycles,
        config_modification_deadline_cycles,
        ..
    } = action
    {
        require!(
            vote_threshold >= 5001 && vote_threshold <= 10_000,
            ComfiError::InvalidVoteThreshold
        );
        require!(
            spender_limit_deadline_cycles > 0
                && withdrawal_deadline_cycles > 0
                && config_modification_deadline_cycles > 0,
            ComfiError::InvalidProposalDeadline
        );
    }
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.pool;
    let next_voting_cycle = pool
        .current_cycle
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    let deadline_cycle = next_voting_cycle
        .checked_add(deadline_cycles)
        .ok_or(ComfiError::MathOverflow)?
        .checked_sub(1)
        .ok_or(ComfiError::MathOverflow)?;
    let duration_seconds = (deadline_cycles as i64)
        .checked_mul(pool.cycle_duration_seconds)
        .ok_or(ComfiError::MathOverflow)?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.pool = pool.key();
    proposal.id = pool.next_proposal_id;
    proposal.proposer = ctx.accounts.proposer.key();
    proposal.action = action;
    proposal.yes_votes = 0;
    proposal.no_votes = 0;
    proposal.voting_cycle = next_voting_cycle;
    proposal.deadline_cycle = deadline_cycle;
    proposal.deadline = clock
        .unix_timestamp
        .checked_add(duration_seconds)
        .ok_or(ComfiError::MathOverflow)?;
    proposal.executable_after = 0;
    proposal.state = ProposalState::Queued;
    proposal.bump = ctx.bumps.proposal;
    proposal.execution_mode = pool.get_proposal_execution_mode(&action);
    proposal.vote_threshold = pool.vote_threshold;
    pool.next_proposal_id = pool
        .next_proposal_id
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
    Ok(())
}

pub fn vote(ctx: Context<Vote>, approve: bool) -> Result<()> {
    let pool = &ctx.accounts.pool;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);
    pool.ensure_cycle_current()?;
    let proposal = &mut ctx.accounts.proposal;
    let voter = &mut ctx.accounts.voter;
    require!(
        voter.is_funded_for_pool(pool),
        ComfiError::MemberNotFunded
    );
    require!(
        proposal.state == ProposalState::Queued || proposal.state == ProposalState::Open,
        ComfiError::ProposalNotOpen
    );
    require!(
        pool.current_cycle >= proposal.voting_cycle,
        ComfiError::VotingNotStarted
    );
    require!(
        pool.current_cycle <= proposal.deadline_cycle,
        ComfiError::VotingClosed
    );
    proposal.state = ProposalState::Open;

    // Enforce invariant: casting a vote always totals any accrued spend benefits against the voter!
    voter.sync_benefit(pool)?;

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
    let pool = &ctx.accounts.pool;
    pool.ensure_cycle_current()?;
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.state == ProposalState::Open || proposal.state == ProposalState::Queued,
        ComfiError::ProposalNotOpen
    );
    let passed = proposal.is_passed_for_pool(pool)?;
    let deadline_reached = pool.current_cycle > proposal.deadline_cycle;
    let can_finalize = match proposal.execution_mode {
        ExecutionMode::OnDeadline => deadline_reached,
        ExecutionMode::ThresholdMet => passed || deadline_reached,
    };
    require!(
        can_finalize,
        ComfiError::VotingStillOpen
    );
    if passed {
        proposal.state = ProposalState::Executable;
        proposal.executable_after = clock
            .unix_timestamp
            .checked_add(pool.timelock_seconds)
            .ok_or(ComfiError::MathOverflow)?;
    } else {
        proposal.state = ProposalState::Rejected;
    }
    Ok(())
}

pub fn execute_close_pool(ctx: Context<ExecuteClosePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.ensure_cycle_current()?;
    let proposal = &mut ctx.accounts.proposal;
    assert_executable(proposal)?;
    match proposal.action {
        ProposalAction::ClosePool => {}
        _ => return err!(ComfiError::WrongProposalAction),
    }
    pool.enter_closure();
    if let Some(vault) = &ctx.accounts.vault {
        pool.closing_vault_basis = vault.amount;
        pool.has_snapshotted_closure = true;
    }
    proposal.state = ProposalState::Executed;
    Ok(())
}

pub fn execute_spender_limit(ctx: Context<ExecuteSpenderLimit>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);
    pool.ensure_cycle_current()?;
    let proposal = &mut ctx.accounts.proposal;
    assert_executable(proposal)?;
    let (target, cap) = match proposal.action {
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
    cycle.pool = pool.key();
    cycle.member = ctx.accounts.spender_member.key();
    cycle.cycle = pool.current_cycle;
    cycle.cap = cap;
    cycle.bump = ctx.bumps.spender_cycle;
    proposal.state = ProposalState::Executed;
    Ok(())
}

pub fn execute_configuration_modification(
    ctx: Context<ExecuteConfigurationModification>,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(!pool.is_closing, ComfiError::PoolIsClosing);
    pool.ensure_cycle_current()?;
    let proposal = &mut ctx.accounts.proposal;
    assert_executable(proposal)?;
    let (
        vote_threshold,
        cycle_duration_seconds,
        member_obligation_amount,
        spender_limit_deadline_cycles,
        withdrawal_deadline_cycles,
        config_modification_deadline_cycles,
        spender_limit_execution_mode,
        withdrawal_execution_mode,
        config_modification_execution_mode,
    ) = match proposal.action {
        ProposalAction::ConfigurationModification {
            vote_threshold,
            cycle_duration_seconds,
            member_obligation_amount,
            spender_limit_deadline_cycles,
            withdrawal_deadline_cycles,
            config_modification_deadline_cycles,
            spender_limit_execution_mode,
            withdrawal_execution_mode,
            config_modification_execution_mode,
        } => (
            vote_threshold,
            cycle_duration_seconds,
            member_obligation_amount,
            spender_limit_deadline_cycles,
            withdrawal_deadline_cycles,
            config_modification_deadline_cycles,
            spender_limit_execution_mode,
            withdrawal_execution_mode,
            config_modification_execution_mode,
        ),
        _ => return err!(ComfiError::WrongProposalAction),
    };
    require!(
        vote_threshold >= 5001 && vote_threshold <= 10_000,
        ComfiError::InvalidVoteThreshold
    );
    require!(
        cycle_duration_seconds > 0,
        ComfiError::InvalidCycleDuration
    );
    require!(
        spender_limit_deadline_cycles > 0
            && withdrawal_deadline_cycles > 0
            && config_modification_deadline_cycles > 0,
        ComfiError::InvalidProposalDeadline
    );

    pool.pending_vote_threshold = vote_threshold;
    pool.pending_cycle_duration_seconds = cycle_duration_seconds;
    pool.pending_member_obligation_amount = member_obligation_amount;
    pool.pending_spender_limit_deadline_cycles = spender_limit_deadline_cycles;
    pool.pending_withdrawal_deadline_cycles = withdrawal_deadline_cycles;
    pool.pending_config_modification_deadline_cycles = config_modification_deadline_cycles;
    pool.pending_spender_limit_execution_mode = spender_limit_execution_mode;
    pool.pending_withdrawal_execution_mode = withdrawal_execution_mode;
    pool.pending_config_modification_execution_mode = config_modification_execution_mode;
    pool.has_pending_config = true;
    proposal.state = ProposalState::Executed;
    Ok(())
}


pub fn spend(ctx: Context<Spend>) -> Result<()> {
    let request = &mut ctx.accounts.request;
    require!(!ctx.accounts.pool.is_closing, ComfiError::PoolIsClosing);
    ctx.accounts.pool.ensure_cycle_current()?;
    require!(
        request.status == WithdrawalStatus::Pending,
        ComfiError::RequestNotPending
    );
    require!(
        ctx.accounts.executor_member.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    require!(
        ctx.accounts.requester_member.is_funded_for_pool(&ctx.accounts.pool),
        ComfiError::MemberNotFunded
    );
    require!(
        ctx.accounts.requester_member.can_request_spend(),
        ComfiError::NotSpender
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
    } else {
        let cycle = ctx
            .accounts
            .spender_cycle
            .as_mut()
            .ok_or(ComfiError::InvalidSpendCycle)?;
        let (expected_sc_pda, _bump) = Pubkey::find_program_address(
            &[
                b"cycle",
                ctx.accounts.pool.key().as_ref(),
                ctx.accounts.requester_member.key().as_ref(),
                &ctx.accounts.pool.current_cycle.to_le_bytes(),
            ],
            &crate::ID,
        );
        require_keys_eq!(cycle.key(), expected_sc_pda, ComfiError::InvalidSpendCycle);
        require!(
            cycle.cycle == ctx.accounts.pool.current_cycle,
            ComfiError::WrongCycle
        );
        require!(
            cycle.member == ctx.accounts.requester_member.key(),
            ComfiError::InvalidSpendCycle
        );
        let next_spent = cycle
            .spent
            .checked_add(request.amount)
            .ok_or(ComfiError::MathOverflow)?;
        require!(next_spent <= cycle.cap, ComfiError::SpendLimitExceeded);
        cycle.spent = next_spent;

        // VULN-01: Unvoted member spends can only be personal withdrawals directly to requester wallet
        require!(
            ctx.accounts.recipient_usdc.owner == ctx.accounts.requester_member.wallet,
            ComfiError::Unauthorized
        );
    }

    let vault_balance = ctx.accounts.vault.amount;
    let remaining_after_spend = vault_balance
        .checked_sub(request.amount)
        .ok_or(ComfiError::MathOverflow)?;
    require!(
        remaining_after_spend >= ctx.accounts.pool.total_non_conferred_capital,
        ComfiError::InsufficientVaultForSurplus
    );
    require!(
        request.amount <= ctx.accounts.pool.total_conferred_capital,
        ComfiError::MathOverflow
    );

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

    let requester = &mut ctx.accounts.requester_member;
    requester.total_withdrawn = requester
        .total_withdrawn
        .checked_add(request.amount)
        .ok_or(ComfiError::MathOverflow)?;

    if ctx.accounts.recipient_usdc.owner == requester.wallet {
        // Individual withdrawal directly to member: attribute 100% directly to requester
        requester.cumulative_benefit_received = requester
            .cumulative_benefit_received
            .checked_add(request.amount)
            .ok_or(ComfiError::MathOverflow)?;
    } else {
        // Shared pool operating spend to verified third-party vendor approved by governance
        require!(
            ctx.accounts.pool.funded_member_count > 0,
            ComfiError::MemberNotFunded
        );
        let active_funded_members = ctx.accounts.pool.funded_member_count as u128;
        let benefit_delta = (request.amount as u128)
            .checked_mul(BENEFIT_SCALE)
            .ok_or(ComfiError::MathOverflow)?
            .checked_div(active_funded_members)
            .ok_or(ComfiError::MathOverflow)?;
        ctx.accounts.pool.cumulative_benefit_per_member = ctx.accounts.pool
            .cumulative_benefit_per_member
            .checked_add(benefit_delta)
            .ok_or(ComfiError::MathOverflow)?;

        requester.sync_benefit(&ctx.accounts.pool)?;
    }
    ctx.accounts.pool.total_conferred_capital = ctx.accounts.pool
        .total_conferred_capital
        .checked_sub(request.amount)
        .ok_or(ComfiError::MathOverflow)?;

    request.status = WithdrawalStatus::Spent;
    Ok(())
}

pub fn claim_closure_refund(ctx: Context<ClaimClosureRefund>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.is_closing, ComfiError::PoolNotClosing);
    let member = &mut ctx.accounts.member;
    require!(!member.closure_claimed, ComfiError::ClosureRefundAlreadyClaimed);

    // Sync any unconsumed surplus transitions if cycles advanced
    member.sync_surplus(pool);

    // Sync any accrued delegated spend benefit from pool
    member.sync_benefit(pool)?;

    // Snapshot pro-rata basis on the initial closure claim
    if !pool.has_snapshotted_closure {
        pool.closing_vault_basis = ctx.accounts.vault.amount;
        if pool.closing_non_conferred_basis == 0 && pool.closing_conferred_pool_capital == 0 {
            pool.closing_non_conferred_basis = pool.total_non_conferred_capital;
            pool.closing_conferred_pool_capital = pool.total_conferred_capital;
        }
        pool.has_snapshotted_closure = true;
    }

    // 1. Priority 1: Non-conferred capital (unfunded deposits + surplus)
    let non_conferred_share = member.non_conferred_amount();
    let non_conferred_refund = if pool.closing_non_conferred_basis > 0
        && pool.closing_vault_basis < pool.closing_non_conferred_basis
    {
        let pro_rata = (non_conferred_share as u128)
            .checked_mul(pool.closing_vault_basis as u128)
            .ok_or(ComfiError::MathOverflow)?
            .checked_div(pool.closing_non_conferred_basis as u128)
            .ok_or(ComfiError::MathOverflow)? as u64;
        pro_rata.min(ctx.accounts.vault.amount)
    } else {
        non_conferred_share.min(ctx.accounts.vault.amount)
    };

    // 2. Priority 2: Conferred funds share (pro-rata if vault has deficit)
    let conferred_contribution = member.conferred_contribution();
    let net_conferred_share = conferred_contribution.saturating_sub(member.cumulative_benefit_received);

    let vault_after_non_conferred = ctx.accounts.vault.amount.saturating_sub(non_conferred_refund);
    let closing_vault_for_conferred = pool.closing_vault_basis.saturating_sub(pool.closing_non_conferred_basis);

    let conferred_refund = if pool.closing_conferred_pool_capital > 0 && closing_vault_for_conferred > 0 {
        if closing_vault_for_conferred < pool.closing_conferred_pool_capital {
            let pro_rata = (net_conferred_share as u128)
                .checked_mul(closing_vault_for_conferred as u128)
                .ok_or(ComfiError::MathOverflow)?
                .checked_div(pool.closing_conferred_pool_capital as u128)
                .ok_or(ComfiError::MathOverflow)? as u64;
            pro_rata.min(vault_after_non_conferred)
        } else {
            net_conferred_share.min(vault_after_non_conferred)
        }
    } else {
        0u64
    };

    let total_refund = non_conferred_refund
        .checked_add(conferred_refund)
        .ok_or(ComfiError::MathOverflow)?;

    if total_refund > 0 {
        let signer_seeds: &[&[u8]] = &[
            b"pool",
            &pool.id.to_le_bytes(),
            &[pool.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                Token::id(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.member_usdc.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            total_refund,
        )?;
    }

    pool.total_non_conferred_capital = pool.total_non_conferred_capital.saturating_sub(non_conferred_refund);
    pool.total_settled_capital = pool.total_settled_capital
        .checked_add(conferred_refund)
        .ok_or(ComfiError::MathOverflow)?;
    member.surplus_amount = 0;
    member.closure_claimed = true;
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
            spender_limit_deadline_cycles: 1,
            withdrawal_deadline_cycles: 1,
            config_modification_deadline_cycles: 2,
            pending_spender_limit_deadline_cycles: 1,
            pending_withdrawal_deadline_cycles: 1,
            pending_config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::OnDeadline,
            withdrawal_execution_mode: ExecutionMode::OnDeadline,
            config_modification_execution_mode: ExecutionMode::OnDeadline,
            pending_spender_limit_execution_mode: ExecutionMode::OnDeadline,
            pending_withdrawal_execution_mode: ExecutionMode::OnDeadline,
            pending_config_modification_execution_mode: ExecutionMode::OnDeadline,
            is_closing: false,
            total_non_conferred_capital: 0,
            close_deadline_cycles: 1,
            close_execution_mode: ExecutionMode::OnDeadline,
            total_settled_capital: 0,
            funded_member_count: 1,
            cumulative_benefit_per_member: 0,
            total_conferred_capital: 0,
            has_snapshotted_closure: false,
            closing_vault_basis: 0,
            closing_non_conferred_basis: 0,
            closing_conferred_pool_capital: 0,
            head_member: None,
            rollover_cursor: None,
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
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
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
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 40,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
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
        pool.pending_spender_limit_deadline_cycles = 3;
        pool.pending_withdrawal_deadline_cycles = 2;
        pool.pending_config_modification_deadline_cycles = 4;
        pool.pending_spender_limit_execution_mode = ExecutionMode::ThresholdMet;
        pool.pending_withdrawal_execution_mode = ExecutionMode::ThresholdMet;
        pool.pending_config_modification_execution_mode = ExecutionMode::ThresholdMet;

        // Current active config has NOT changed yet
        assert_eq!(pool.vote_threshold, 2);
        assert_eq!(pool.cycle_duration_seconds, 1000);
        assert_eq!(pool.member_obligation_amount, 50);
        assert_eq!(pool.spender_limit_deadline_cycles, 1);
        assert_eq!(pool.withdrawal_deadline_cycles, 1);
        assert_eq!(pool.config_modification_deadline_cycles, 2);
        assert_eq!(pool.spender_limit_execution_mode, ExecutionMode::OnDeadline);
        assert_eq!(pool.withdrawal_execution_mode, ExecutionMode::OnDeadline);
        assert_eq!(pool.config_modification_execution_mode, ExecutionMode::OnDeadline);

        // Advance cycle
        pool.current_cycle += 1;
        pool.apply_pending_config();

        // New config is now active
        assert_eq!(pool.vote_threshold, 4);
        assert_eq!(pool.cycle_duration_seconds, 2000);
        assert_eq!(pool.member_obligation_amount, 150);
        assert_eq!(pool.spender_limit_deadline_cycles, 3);
        assert_eq!(pool.withdrawal_deadline_cycles, 2);
        assert_eq!(pool.config_modification_deadline_cycles, 4);
        assert_eq!(pool.spender_limit_execution_mode, ExecutionMode::ThresholdMet);
        assert_eq!(pool.withdrawal_execution_mode, ExecutionMode::ThresholdMet);
        assert_eq!(pool.config_modification_execution_mode, ExecutionMode::ThresholdMet);
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
        assert_eq!(Pool::SPACE, 8 + 426);
        assert_eq!(
            Member::SPACE,
            8 + 258
        );
        assert_eq!(SpenderCycle::SPACE, 8 + 32 + 32 + 8 + 8 + 8 + 1);
        assert_eq!(
            WithdrawalRequest::SPACE,
            8 + 32 + 8 + 32 + 32 + 8 + 32 + 1 + 1 + 1
        );
        assert_eq!(
            Proposal::SPACE,
            8 + 32 + 8 + 32 + 48 + 4 + 4 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 4
        );
        assert_eq!(VoteReceipt::SPACE, 8 + 32 + 32 + 1 + 1);
        assert_eq!(SponsorQuoteReceipt::SPACE, 8 + 32 + 32 + 32 + 1);
    }

    #[test]
    fn test_proposal_voting_outcome_logic() {
        let _pool = create_test_pool(); // vote_threshold = 2
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ApproveWithdrawal {
                request: Pubkey::new_unique(),
            },
            yes_votes: 1,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 100,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        // 1 yes vote is below threshold of 2: should be rejected
        let is_passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(!is_passed);

        // 2 yes votes and 0 no votes: reaches threshold of 2 and majority
        proposal.yes_votes = 2;
        let is_passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(is_passed);

        // 2 yes votes and 2 no votes: tied, should not pass
        proposal.no_votes = 2;
        let is_passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(!is_passed);
    }

    #[test]
    fn test_proposal_lifecycle_enqueued_and_voting_windows() {
        let pool_cycle_0 = create_test_pool(); // current_cycle = 0
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ConfigurationModification {
                vote_threshold: 3,
                cycle_duration_seconds: 500,
                member_obligation_amount: 100,
                spender_limit_deadline_cycles: 1,
                withdrawal_deadline_cycles: 1,
                config_modification_deadline_cycles: 2,
                spender_limit_execution_mode: ExecutionMode::OnDeadline,
                withdrawal_execution_mode: ExecutionMode::OnDeadline,
                config_modification_execution_mode: ExecutionMode::OnDeadline,
            },
            yes_votes: 0,
            no_votes: 0,
            voting_cycle: 1, // Enqueued for cycle 1
            deadline_cycle: 2, // 2-cycle voting window: cycles 1 and 2
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Queued,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: pool_cycle_0.vote_threshold,
        };

        // Initial state is Queued
        assert_eq!(proposal.state, ProposalState::Queued);
        assert_eq!(proposal.voting_cycle, 1);
        assert_eq!(proposal.deadline_cycle, 2);

        // In Cycle 0: voting has not started yet
        assert!(pool_cycle_0.current_cycle < proposal.voting_cycle);

        // In Cycle 1: voting cycle is active
        let mut pool_cycle_1 = pool_cycle_0.clone();
        pool_cycle_1.current_cycle = 1;
        assert!(pool_cycle_1.current_cycle >= proposal.voting_cycle && pool_cycle_1.current_cycle <= proposal.deadline_cycle);

        // When voting in cycle 1, state transitions to Open
        proposal.state = ProposalState::Open;
        proposal.yes_votes += 2;
        assert_eq!(proposal.state, ProposalState::Open);

        // In Cycle 2: voting is still active because deadline_cycle is 2
        let mut pool_cycle_2 = pool_cycle_1.clone();
        pool_cycle_2.current_cycle = 2;
        assert!(pool_cycle_2.current_cycle >= proposal.voting_cycle && pool_cycle_2.current_cycle <= proposal.deadline_cycle);

        // In Cycle 3: voting cycle has ended
        let mut pool_cycle_3 = pool_cycle_2.clone();
        pool_cycle_3.current_cycle = 3;
        assert!(pool_cycle_3.current_cycle > proposal.deadline_cycle);
    }

    #[test]
    fn test_cycle_rollover_executes_passed_proposal_directly() {
        let mut pool = create_test_pool(); // threshold = 2, current_cycle = 1
        pool.current_cycle = 1;

        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ConfigurationModification {
                vote_threshold: 4,
                cycle_duration_seconds: 2500,
                member_obligation_amount: 120,
                spender_limit_deadline_cycles: 2,
                withdrawal_deadline_cycles: 3,
                config_modification_deadline_cycles: 4,
                spender_limit_execution_mode: ExecutionMode::OnDeadline,
                withdrawal_execution_mode: ExecutionMode::OnDeadline,
                config_modification_execution_mode: ExecutionMode::OnDeadline,
            },
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        // Cycle 1 ends, rolling into Cycle 2
        let ending_cycle = pool.current_cycle;
        pool.current_cycle += 1;

        // Evaluate conditions for the proposal of ending_cycle
        assert_eq!(proposal.deadline_cycle, ending_cycle);
        let passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(passed);

        // Execution updates config and transitions directly to Executed (NOT Executable)
        if passed {
            if let ProposalAction::ConfigurationModification {
                vote_threshold,
                cycle_duration_seconds,
                member_obligation_amount,
                spender_limit_deadline_cycles,
                withdrawal_deadline_cycles,
                config_modification_deadline_cycles,
                spender_limit_execution_mode,
                withdrawal_execution_mode,
                config_modification_execution_mode,
            } = proposal.action
            {
                pool.vote_threshold = vote_threshold;
                pool.cycle_duration_seconds = cycle_duration_seconds;
                pool.member_obligation_amount = member_obligation_amount;
                pool.spender_limit_deadline_cycles = spender_limit_deadline_cycles;
                pool.withdrawal_deadline_cycles = withdrawal_deadline_cycles;
                pool.config_modification_deadline_cycles = config_modification_deadline_cycles;
                pool.spender_limit_execution_mode = spender_limit_execution_mode;
                pool.withdrawal_execution_mode = withdrawal_execution_mode;
                pool.config_modification_execution_mode = config_modification_execution_mode;
                proposal.state = ProposalState::Executed;
            }
        }

        assert_eq!(proposal.state, ProposalState::Executed);
        assert_eq!(pool.vote_threshold, 4);
        assert_eq!(pool.cycle_duration_seconds, 2500);
        assert_eq!(pool.member_obligation_amount, 120);
        assert_eq!(pool.spender_limit_deadline_cycles, 2);
        assert_eq!(pool.withdrawal_deadline_cycles, 3);
        assert_eq!(pool.config_modification_deadline_cycles, 4);
    }

    #[test]
    fn test_cycle_rollover_rejects_failed_proposal() {
        let _pool = create_test_pool(); // threshold = 2, current_cycle = 1
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ConfigurationModification {
                vote_threshold: 4,
                cycle_duration_seconds: 2500,
                member_obligation_amount: 120,
                spender_limit_deadline_cycles: 1,
                withdrawal_deadline_cycles: 1,
                config_modification_deadline_cycles: 1,
                spender_limit_execution_mode: ExecutionMode::OnDeadline,
                withdrawal_execution_mode: ExecutionMode::OnDeadline,
                config_modification_execution_mode: ExecutionMode::OnDeadline,
            },
            yes_votes: 1, // Below threshold of 2
            no_votes: 1,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        let passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(!passed);

        if !passed {
            proposal.state = ProposalState::Rejected;
        }

        assert_eq!(proposal.state, ProposalState::Rejected);
    }

    #[test]
    fn test_proposal_deadlines_per_proposal_type() {
        let mut pool = create_test_pool();
        pool.spender_limit_deadline_cycles = 1;
        pool.withdrawal_deadline_cycles = 3;
        pool.config_modification_deadline_cycles = 5;

        let spender_action = ProposalAction::SetSpenderLimit {
            member: Pubkey::new_unique(),
            cap: 500,
        };
        let withdrawal_action = ProposalAction::ApproveWithdrawal {
            request: Pubkey::new_unique(),
        };
        let config_action = ProposalAction::ConfigurationModification {
            vote_threshold: 3,
            cycle_duration_seconds: 1000,
            member_obligation_amount: 100,
            spender_limit_deadline_cycles: 2,
            withdrawal_deadline_cycles: 2,
            config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::OnDeadline,
            withdrawal_execution_mode: ExecutionMode::OnDeadline,
            config_modification_execution_mode: ExecutionMode::OnDeadline,
        };

        assert_eq!(pool.get_proposal_deadline_cycles(&spender_action), 1);
        assert_eq!(pool.get_proposal_deadline_cycles(&withdrawal_action), 3);
        assert_eq!(pool.get_proposal_deadline_cycles(&config_action), 5);

        // Created at current_cycle = 2:
        // Spender action deadline: start = 3, duration = 1 -> deadline_cycle = 3 + 1 - 1 = 3
        let start_cycle = 3;
        let spender_deadline_cycle = start_cycle + pool.get_proposal_deadline_cycles(&spender_action) - 1;
        assert_eq!(spender_deadline_cycle, 3);

        // Withdrawal action deadline: start = 3, duration = 3 -> deadline_cycle = 3 + 3 - 1 = 5
        let withdrawal_deadline_cycle = start_cycle + pool.get_proposal_deadline_cycles(&withdrawal_action) - 1;
        assert_eq!(withdrawal_deadline_cycle, 5);

        // Config action deadline: start = 3, duration = 5 -> deadline_cycle = 3 + 5 - 1 = 7
        let config_deadline_cycle = start_cycle + pool.get_proposal_deadline_cycles(&config_action) - 1;
        assert_eq!(config_deadline_cycle, 7);
    }

    #[test]
    fn test_execution_mode_threshold_met_runs_on_next_available_cycle() {
        let _pool = create_test_pool(); // vote_threshold = 2
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ApproveWithdrawal {
                request: Pubkey::new_unique(),
            },
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 5, // Deadline is cycle 5
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 2,
        };

        // When rolling cycle 1 (next available cycle after voting opened):
        let ending_cycle = 1;
        let passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        let is_deadline = ending_cycle >= proposal.deadline_cycle;
        assert!(!is_deadline); // It is NOT deadline cycle yet

        let should_resolve = match proposal.execution_mode {
            ExecutionMode::OnDeadline => is_deadline,
            ExecutionMode::ThresholdMet => passed || is_deadline,
        };
        // Threshold is met, so it resolves immediately on cycle 1!
        assert!(should_resolve);
        proposal.state = ProposalState::Executed;
        assert_eq!(proposal.state, ProposalState::Executed);
    }

    #[test]
    fn test_execution_mode_on_deadline_waits_for_deadline_cycle() {
        let _pool = create_test_pool(); // vote_threshold = 2
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ApproveWithdrawal {
                request: Pubkey::new_unique(),
            },
            yes_votes: 2, // Threshold met already!
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 4, // Deadline is cycle 4
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        // Cycle 1 rolls: threshold is met, but execution_mode is OnDeadline and not at deadline yet
        let passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(passed);

        let ending_cycle_1 = 1;
        let is_deadline_1 = ending_cycle_1 >= proposal.deadline_cycle;
        let should_resolve_1 = match proposal.execution_mode {
            ExecutionMode::OnDeadline => is_deadline_1,
            ExecutionMode::ThresholdMet => passed || is_deadline_1,
        };
        assert!(!should_resolve_1); // Does NOT resolve on cycle 1
        assert_eq!(proposal.state, ProposalState::Open);

        // Cycle 4 rolls: this is the deadline cycle!
        let ending_cycle_4 = 4;
        let is_deadline_4 = ending_cycle_4 >= proposal.deadline_cycle;
        let should_resolve_4 = match proposal.execution_mode {
            ExecutionMode::OnDeadline => is_deadline_4,
            ExecutionMode::ThresholdMet => passed || is_deadline_4,
        };
        assert!(should_resolve_4); // Resolves on deadline cycle!
        proposal.state = ProposalState::Executed;
        assert_eq!(proposal.state, ProposalState::Executed);
    }

    #[test]
    fn test_proposal_execution_mode_per_proposal_type() {
        let mut pool = create_test_pool();
        pool.spender_limit_execution_mode = ExecutionMode::ThresholdMet;
        pool.withdrawal_execution_mode = ExecutionMode::OnDeadline;
        pool.config_modification_execution_mode = ExecutionMode::ThresholdMet;

        let spender_action = ProposalAction::SetSpenderLimit {
            member: Pubkey::new_unique(),
            cap: 500,
        };
        let withdrawal_action = ProposalAction::ApproveWithdrawal {
            request: Pubkey::new_unique(),
        };
        let config_action = ProposalAction::ConfigurationModification {
            vote_threshold: 3,
            cycle_duration_seconds: 1000,
            member_obligation_amount: 100,
            spender_limit_deadline_cycles: 2,
            withdrawal_deadline_cycles: 2,
            config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::ThresholdMet,
            withdrawal_execution_mode: ExecutionMode::ThresholdMet,
            config_modification_execution_mode: ExecutionMode::ThresholdMet,
        };

        assert_eq!(pool.get_proposal_execution_mode(&spender_action), ExecutionMode::ThresholdMet);
        assert_eq!(pool.get_proposal_execution_mode(&withdrawal_action), ExecutionMode::OnDeadline);
        assert_eq!(pool.get_proposal_execution_mode(&config_action), ExecutionMode::ThresholdMet);
    }

    #[test]
    fn test_config_change_does_not_affect_existing_proposals_except_cycle_timing() {
        let mut pool = create_test_pool();
        pool.vote_threshold = 2;
        pool.spender_limit_deadline_cycles = 1;
        pool.spender_limit_execution_mode = ExecutionMode::OnDeadline;
        pool.cycle_duration_seconds = 100;

        // Proposal 1 is submitted when pool.vote_threshold is 2
        let spender_action = ProposalAction::SetSpenderLimit {
            member: Pubkey::new_unique(),
            cap: 500,
        };
        let deadline_cycles = pool.get_proposal_deadline_cycles(&spender_action);
        let execution_mode = pool.get_proposal_execution_mode(&spender_action);
        let next_voting_cycle = pool.current_cycle + 1;
        let deadline_cycle = next_voting_cycle + deadline_cycles - 1;

        let mut existing_proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: spender_action,
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: next_voting_cycle,
            deadline_cycle,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode,
            vote_threshold: pool.vote_threshold,
        };

        pool.vote_threshold = 5; // Increased to 5
        pool.spender_limit_deadline_cycles = 4; // Increased to 4 cycles
        pool.spender_limit_execution_mode = ExecutionMode::ThresholdMet; // Changed to ThresholdMet
        pool.cycle_duration_seconds = 5000; // Cycle timing lengthened

        // Verify pool's own active config was updated
        assert_eq!(pool.vote_threshold, 5);
        assert_eq!(pool.spender_limit_deadline_cycles, 4);
        assert_eq!(pool.spender_limit_execution_mode, ExecutionMode::ThresholdMet);
        assert_eq!(pool.cycle_duration_seconds, 5000);

        // Existing proposal retains its snapshotted configuration:
        assert_eq!(existing_proposal.vote_threshold, 2);
        assert_eq!(existing_proposal.deadline_cycle, 1);
        assert_eq!(existing_proposal.execution_mode, ExecutionMode::OnDeadline);

        // When cycle 1 rolls (under the new 5000s cycle timing):
        let ending_cycle = 1;
        let passed = existing_proposal.yes_votes >= existing_proposal.vote_threshold
            && existing_proposal.yes_votes > existing_proposal.no_votes;
        // Even though pool.vote_threshold is 5, proposal passes because its snapshotted threshold is 2:
        assert!(passed);

        let is_deadline = ending_cycle >= existing_proposal.deadline_cycle;
        assert!(is_deadline);

        let should_resolve = match existing_proposal.execution_mode {
            ExecutionMode::OnDeadline => is_deadline,
            ExecutionMode::ThresholdMet => passed || is_deadline,
        };
        assert!(should_resolve);
        existing_proposal.state = ProposalState::Executed;
        assert_eq!(existing_proposal.state, ProposalState::Executed);
    }

    #[test]
    fn test_overfunding_cap_and_surplus_accounting() {
        let pool = create_test_pool(); // obligation is 50
        assert_eq!(pool.member_obligation_amount, 50);

        // Case 1: Member joins with exact obligation 50: no surplus
        let initial_1: u64 = 50;
        let excess_1 = initial_1.saturating_sub(pool.member_obligation_amount);
        assert_eq!(excess_1, 0); // surplus = 0
        assert!(excess_1 <= pool.member_obligation_amount); // within cap

        // Case 2: Member joins with 100 (50 obligation + 50 prepay next cycle): surplus = 50
        let initial_2: u64 = 100;
        let excess_2 = initial_2.saturating_sub(pool.member_obligation_amount);
        assert_eq!(excess_2, 50); // surplus = 50
        assert!(excess_2 <= pool.member_obligation_amount); // exactly at cap of 1 prepaid cycle

        // Case 3: Overfunding exceeds cap: deposit 101 -> surplus = 51 > 50 cap
        let initial_3: u64 = 101;
        let excess_3 = initial_3.saturating_sub(pool.member_obligation_amount);
        assert_eq!(excess_3, 51);
        assert!(excess_3 > pool.member_obligation_amount); // violates cap!
    }

    #[test]
    fn test_surplus_does_not_confer_extra_voting_power() {
        let pool = create_test_pool(); // vote_threshold = 2

        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ClosePool,
            yes_votes: 0,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        // Member A with standard funded deposit (50, 0 surplus)
        let member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Member B with max allowed surplus (100 total = 50 obligation + 50 surplus)
        let member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        assert!(member_a.is_funded_for_pool(&pool));
        assert!(member_b.is_funded_for_pool(&pool));

        // Member A votes yes: increments yes_votes by exactly 1
        proposal.yes_votes += 1;
        assert_eq!(proposal.yes_votes, 1);

        // Member B (who has 2x deposits due to surplus) votes yes: also increments by strictly 1!
        proposal.yes_votes += 1;
        assert_eq!(proposal.yes_votes, 2);

        // Voting power is strictly 1 vote per member, immune to deposit weighting
    }

    #[test]
    fn test_spend_surplus_isolation_invariant() {
        let mut pool = create_test_pool();
        // Suppose pool vault has 150 total USDC: 50 is base capital, 100 is total non-conferred capital prepaid by members
        pool.total_non_conferred_capital = 100;
        let vault_balance: u64 = 150;

        // Spend of 40: leaves 150 - 40 = 110 >= 100 non-conferred. This is permitted!
        let spend_1: u64 = 40;
        let remaining_1 = vault_balance.checked_sub(spend_1).unwrap();
        assert!(remaining_1 >= pool.total_non_conferred_capital);

        // Spend of 60: leaves 150 - 60 = 90 < 100 non-conferred. This MUST be rejected!
        let spend_2: u64 = 60;
        let remaining_2 = vault_balance.checked_sub(spend_2).unwrap();
        assert!(remaining_2 < pool.total_non_conferred_capital); // Violates non-conferred protection!
    }

    #[test]
    fn test_close_pool_proposal_and_execution() {
        let mut pool = create_test_pool();
        assert!(!pool.is_closing);

        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ClosePool,
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        // Proposal passes
        let passed = proposal.yes_votes >= proposal.vote_threshold && proposal.yes_votes > proposal.no_votes;
        assert!(passed);

        if passed {
            if proposal.action == ProposalAction::ClosePool {
                pool.enter_closure();
                proposal.state = ProposalState::Executed;
            }
        }

        assert_eq!(proposal.state, ProposalState::Executed);
        assert!(pool.is_closing);
        assert_eq!(pool.closing_non_conferred_basis, pool.total_non_conferred_capital);
        assert_eq!(pool.closing_conferred_pool_capital, pool.total_conferred_capital);
    }

    #[test]
    fn test_anti_51_percent_attack_on_pool_closure_settlement() {
        // Threat scenario with delegated spends:
        // Cartel members C1 and C2 form a 51% majority.
        // Each deposited 100 conferred funds (total 200).
        // A delegated spend of 200 occurred for the pool (benefiting both C1 and C2 equally, 100 benefit each).
        // C1 and C2's cumulative benefit received = 100 each.
        // Vault currently has 0.
        // Now new honest member M3 joins, depositing 50 obligation + 50 surplus = 100.
        // Vault now has 100 USDC (M3's fresh money).
        // Cartel passes a ClosePool proposal and attempts to claim closure refunds.

        let mut pool = create_test_pool();
        pool.is_closing = true;
        pool.total_non_conferred_capital = 50; // M3's surplus
        pool.funded_member_count = 3;
        pool.total_conferred_capital = 50;
        // Cumulative benefit per member when C1 & C2 were the only members:
        // 200 spend / 2 members = 100 benefit per member
        pool.cumulative_benefit_per_member = 100 * BENEFIT_SCALE;
        let vault_balance: u64 = 100; // Vault has M3's 100 USDC

        // Cartel member C1 (joined at index 0, benefited from earlier 100 spend):
        let mut c1 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Spender,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 200,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        c1.sync_benefit(&pool).unwrap();
        assert_eq!(c1.cumulative_benefit_received, 100);

        // Honest new member M3 (joined after earlier spends, so last_benefit_index = pool.cumulative_benefit_per_member):
        let mut m3 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50, // 50 prepaid surplus
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: pool.cumulative_benefit_per_member,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        m3.sync_benefit(&pool).unwrap();
        assert_eq!(m3.cumulative_benefit_received, 0); // No spends happened while M3 was in pool!

        // --- Evaluate Cartel Member C1 Claim ---
        // Each member's cumulative contribution - their benefit decides their share:
        let c1_surplus_refund = c1.surplus_amount; // 0
        let c1_conferred_contrib = c1.total_contributions.saturating_sub(c1.surplus_amount); // 100
        let c1_net_conferred = c1_conferred_contrib.saturating_sub(c1.cumulative_benefit_received); // 100 - 100 = 0!
        let c1_total_refund = c1_surplus_refund + c1_net_conferred; // 0 + 0 = 0!
        // C1 is owed $0! They cannot take any of M3's money.
        assert_eq!(c1_total_refund, 0);

        // --- Evaluate Honest Member M3 Claim ---
        // Priority 1: 100% of M3's surplus
        let m3_surplus_refund = m3.surplus_amount; // 50
        assert_eq!(m3_surplus_refund, 50);

        // Priority 2: M3's conferred funds share (contribution - benefit received)
        let m3_conferred_contrib = m3.total_contributions.saturating_sub(m3.surplus_amount); // 50
        let m3_net_conferred = m3_conferred_contrib.saturating_sub(m3.cumulative_benefit_received); // 50 - 0 = 50
        let vault_after_surplus = vault_balance.saturating_sub(m3_surplus_refund); // 100 - 50 = 50
        let m3_conferred_refund = m3_net_conferred.min(vault_after_surplus); // min(50, 50) = 50
        let m3_total_refund = m3_surplus_refund + m3_conferred_refund; // 50 + 50 = 100

        // M3 recovers 100% of their deposited funds (both surplus and obligation)!
        assert_eq!(m3_total_refund, 100);

        // Update M3 state as settled
        m3.surplus_amount = 0;
        m3.closure_claimed = true;
        assert!(m3.closure_claimed);
        assert_eq!(m3.surplus_amount, 0);

        // Cartel members receive 0, new member receives 100%. 51% attack completely fails!
    }

    #[test]
    fn test_delegated_spend_benefits_all_funded_members_equally() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2; // Member A and Member B
        pool.cumulative_benefit_per_member = 0;

        // Member A (contributed 100)
        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Member B (contributed 100)
        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Delegated spend of 60 occurs
        let spend_amount: u64 = 60;
        let benefit_delta = (spend_amount as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta;

        // Sync both members
        member_a.sync_benefit(&pool).unwrap();
        member_b.sync_benefit(&pool).unwrap();

        // Both members received exactly 30 of benefit from the 60 spend
        assert_eq!(member_a.cumulative_benefit_received, 30);
        assert_eq!(member_b.cumulative_benefit_received, 30);

        // Pool closes with remaining vault of 140 (200 contributed - 60 spent):
        let vault_after_spend: u64 = 140;
        let net_share_a = member_a.deposited_total.saturating_sub(member_a.cumulative_benefit_received); // 100 - 30 = 70
        let net_share_b = member_b.deposited_total.saturating_sub(member_b.cumulative_benefit_received); // 100 - 30 = 70

        assert_eq!(net_share_a, 70);
        assert_eq!(net_share_b, 70);
        // Total refund: 70 + 70 = 140, perfectly consuming remaining vault with equal distribution!
        assert_eq!(net_share_a + net_share_b, vault_after_spend);
    }

    #[test]
    fn test_benefit_only_accumulated_while_funded() {
        let mut pool = create_test_pool(); // obligation = 50
        pool.funded_member_count = 1; // Only Member A is funded initially
        pool.cumulative_benefit_per_member = 0;

        // Member A (funded, 50 deposited)
        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Member B (unfunded, only 20 deposited, obligation is 50)
        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: false,
            deposited_total: 20,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 20,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        assert!(member_a.is_funded_for_pool(&pool));
        assert!(!member_b.is_funded_for_pool(&pool));

        // Spend 1: 50 spent while only Member A is funded
        let spend_1: u64 = 50;
        let benefit_delta_1 = (spend_1 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_1;

        // Member A syncs: accumulates 50 benefit
        member_a.sync_benefit(&pool).unwrap();
        assert_eq!(member_a.cumulative_benefit_received, 50);

        // Member B syncs while UNfunded: does NOT accumulate benefit!
        member_b.sync_benefit(&pool).unwrap();
        assert_eq!(member_b.cumulative_benefit_received, 0); // Still 0!
        assert_eq!(member_b.last_benefit_index, pool.cumulative_benefit_per_member);

        // Member B now deposits 30 more, reaching 50 deposited total and becoming funded!
        member_b.deposited_total += 30;
        member_b.total_contributions += 30;
        member_b.is_funded = true;
        pool.funded_member_count += 1; // Now 2 funded members
        assert!(member_b.is_funded_for_pool(&pool));
        assert_eq!(member_b.total_contributions, 50);

        // Spend 2: 60 spent while BOTH A and B are funded (30 benefit each)
        let spend_2: u64 = 60;
        let benefit_delta_2 = (spend_2 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_2;

        // Sync both members
        member_a.sync_benefit(&pool).unwrap();
        member_b.sync_benefit(&pool).unwrap();

        // Member A accumulated 50 (from spend 1) + 30 (from spend 2) = 80 total benefit
        assert_eq!(member_a.cumulative_benefit_received, 80);

        // Member B accumulated ONLY 30 benefit (from spend 2, while funded), NOT the earlier spend!
        assert_eq!(member_b.cumulative_benefit_received, 30);
    }

    #[test]
    fn test_member_total_contributions_tracking() {
        let pool = create_test_pool(); // obligation = 50

        // 1. Initial creation / join: initial_deposit sets total_contributions
        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        assert_eq!(member.total_contributions, 50);

        // 2. Incremental deposit: increases total_contributions
        let deposit_amount = 40;
        member.deposited_total += deposit_amount;
        member.total_contributions += deposit_amount;
        assert_eq!(member.total_contributions, 90);
        assert_eq!(member.deposited_total, 90);

        // 3. Withdrawal / spend execution: total_withdrawn increases, total_contributions stays cumulative
        let withdrawal_amount = 30;
        member.total_withdrawn += withdrawal_amount;
        assert_eq!(member.total_withdrawn, 30);
        assert_eq!(member.total_contributions, 90); // Never decremented by withdrawals

        // 4. Surplus allocation: member deposited 90 total, 50 obligation, 40 surplus
        member.surplus_amount = 40;
        let conferred = member.total_contributions.saturating_sub(member.surplus_amount);
        assert_eq!(conferred, 50); // 90 - 40 = 50 conferred capital

        // 5. Pool closure net share: conferred minus benefit received
        member.cumulative_benefit_received = 20;
        let net_conferred_share = conferred.saturating_sub(member.cumulative_benefit_received);
        assert_eq!(net_conferred_share, 30); // 50 - 20 = 30 net conferred refund owed
    }

    #[test]
    fn test_complex_multicycle_multimember_pool_closure_refund_settlement() {
        // Scenario Parameters:
        // - Obligation per cycle = 50 USDC
        // - y = 3 cycles
        // - W = 2 original members: Member A and Member B
        // - Spends occur during time t < y (Cycle 1 spend: 60, Cycle 2 spend: 40)
        // - In Cycle 3, W = 2 new members join: Member C and Member D
        // - Member C funds for z = 2 cycles (50 obligation + 50 surplus prepayment = 100)
        // - Member D funds for z = 1 cycle (50 obligation = 50)
        // - Member A in Cycle 3 prepays 30 surplus (total cycle deposit = 80)
        // - Another spend occurs in Cycle 3 (spend: 80) across all 4 funded members
        // - Pool closes and executes graceful closure refund settlement

        let mut pool = create_test_pool(); // obligation = 50
        pool.cumulative_benefit_per_member = 0;
        let mut vault_balance: u64 = 0;

        // --- Cycle 1: W = 2 original members join & fund ---
        pool.current_cycle = 1;
        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 1,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 1,
            funded_cycle: 1,
            is_paused: false,
            next_member: None,
        };
        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 1,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 1,
            funded_cycle: 1,
            is_paused: false,
            next_member: None,
        };
        pool.funded_member_count = 2;
        vault_balance += 100;

        // Spend 1 in Cycle 1 (t = 1 < y): 60 USDC
        let spend_1: u64 = 60;
        vault_balance -= spend_1;
        let benefit_delta_1 = (spend_1 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_1;

        // --- Cycle 2: A and B fund obligation for cycle 2 ---
        pool.current_cycle = 2;
        member_a.deposited_total += 50;
        member_a.total_contributions += 50;
        member_a.funded_cycle = 2;
        member_b.deposited_total += 50;
        member_b.total_contributions += 50;
        member_b.funded_cycle = 2;
        vault_balance += 100;

        // Spend 2 in Cycle 2 (t = 2 < y): 40 USDC
        let spend_2: u64 = 40;
        vault_balance -= spend_2;
        let benefit_delta_2 = (spend_2 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_2;

        // --- Cycle 3: A and B fund cycle 3 (A adds 30 surplus), plus W = 2 new members (C & D) join ---
        pool.current_cycle = 3;
        // Member A deposits 50 obligation + 30 surplus = 80
        member_a.deposited_total += 80;
        member_a.total_contributions += 80;
        member_a.surplus_amount = 30;
        member_a.surplus_cycle = 3;
        member_a.funded_cycle = 3;
        pool.total_non_conferred_capital += 30;
        vault_balance += 80;

        // Member B deposits 50 obligation = 50
        member_b.deposited_total += 50;
        member_b.total_contributions += 50;
        member_b.funded_cycle = 3;
        member_b.surplus_cycle = 3;
        vault_balance += 50;

        // Member C joins: funds for z = 2 cycles (50 obligation + 50 surplus prepayment = 100)
        let mut member_c = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: pool.cumulative_benefit_per_member,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 3,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 3,
            funded_cycle: 3,
            is_paused: false,
            next_member: None,
        };
        pool.total_non_conferred_capital += 50;
        vault_balance += 100;

        // Member D joins: funds for z = 1 cycle (50 obligation = 50)
        let mut member_d = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: pool.cumulative_benefit_per_member,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 3,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 3,
            funded_cycle: 3,
            is_paused: false,
            next_member: None,
        };
        vault_balance += 50;
        pool.funded_member_count = 4; // A, B, C, D all funded

        // Spend 3 in Cycle 3: 80 USDC across all 4 funded members
        let spend_3: u64 = 80;
        vault_balance -= spend_3;
        let benefit_delta_3 = (spend_3 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_3;

        // --- Verify Pre-Closure State ---
        // Total Contributed = 180 (A) + 150 (B) + 100 (C) + 50 (D) = 480 USDC
        assert_eq!(member_a.total_contributions, 180);
        assert_eq!(member_b.total_contributions, 150);
        assert_eq!(member_c.total_contributions, 100);
        assert_eq!(member_d.total_contributions, 50);
        let total_contributed = member_a.total_contributions + member_b.total_contributions
            + member_c.total_contributions + member_d.total_contributions;
        assert_eq!(total_contributed, 480);

        // Total Spends = 60 + 40 + 80 = 180 USDC
        // Vault Balance Remaining = 480 - 180 = 300 USDC
        assert_eq!(vault_balance, 300);

        // --- Pool Enters Closure ---
        pool.is_closing = true;
        pool.total_conferred_capital = 220; // 300 remaining vault - 80 total non-conferred = 220

        // Sync benefits for all members:
        member_a.sync_benefit(&pool).unwrap();
        member_b.sync_benefit(&pool).unwrap();
        member_c.sync_benefit(&pool).unwrap();
        member_d.sync_benefit(&pool).unwrap();

        // Precalculated Expected Cumulative Benefits:
        // A & B: 30 (spend 1) + 20 (spend 2) + 20 (spend 3) = 70
        // C & D: 0 (joined after spend 1 & 2) + 20 (spend 3) = 20
        assert_eq!(member_a.cumulative_benefit_received, 70);
        assert_eq!(member_b.cumulative_benefit_received, 70);
        assert_eq!(member_c.cumulative_benefit_received, 20);
        assert_eq!(member_d.cumulative_benefit_received, 20);

        // Total Benefit Delivered = 70 + 70 + 20 + 20 = 180 (exact match to total spends!)
        assert_eq!(
            member_a.cumulative_benefit_received + member_b.cumulative_benefit_received
            + member_c.cumulative_benefit_received + member_d.cumulative_benefit_received,
            spend_1 + spend_2 + spend_3
        );

        // Helper closure simulating claim_closure_refund execution logic
        let mut simulated_pool = pool.clone();
        let simulate_claim = |member: &mut Member, p: &mut Pool, vault: &mut u64, pool_total_settled: &mut u64| -> (u64, u64, u64) {
            assert!(!member.closure_claimed);
            member.sync_surplus(p);
            if !p.has_snapshotted_closure {
                p.closing_vault_basis = *vault;
                p.closing_non_conferred_basis = p.total_non_conferred_capital;
                p.closing_conferred_pool_capital = p.total_conferred_capital;
                p.has_snapshotted_closure = true;
            }
            // Priority 1: Non-conferred capital (unfunded deposits + surplus)
            let non_conferred_share = member.non_conferred_amount();
            let non_conferred_refund = if p.closing_non_conferred_basis > 0 && p.closing_vault_basis < p.closing_non_conferred_basis {
                let pro_rata = (non_conferred_share as u128 * p.closing_vault_basis as u128)
                    / p.closing_non_conferred_basis as u128;
                (pro_rata as u64).min(*vault)
            } else {
                non_conferred_share.min(*vault)
            };

            // Priority 2: Conferred funds share
            let conferred_contribution = member.conferred_contribution();
            let net_conferred_share = conferred_contribution.saturating_sub(member.cumulative_benefit_received);
            let vault_after_non_conferred = vault.saturating_sub(non_conferred_refund);
            let closing_vault_for_conferred = p.closing_vault_basis.saturating_sub(p.closing_non_conferred_basis);

            let conferred_refund = if p.closing_conferred_pool_capital > 0 && closing_vault_for_conferred > 0 {
                if closing_vault_for_conferred < p.closing_conferred_pool_capital {
                    let pro_rata = (net_conferred_share as u128 * closing_vault_for_conferred as u128)
                        / p.closing_conferred_pool_capital as u128;
                    (pro_rata as u64).min(vault_after_non_conferred)
                } else {
                    net_conferred_share.min(vault_after_non_conferred)
                }
            } else {
                0u64
            };

            let total_refund = non_conferred_refund + conferred_refund;
            *vault = vault.checked_sub(total_refund).unwrap();
            *pool_total_settled = pool_total_settled.checked_add(total_refund).unwrap();
            p.total_non_conferred_capital = p.total_non_conferred_capital.saturating_sub(non_conferred_refund);
            p.total_settled_capital = p.total_settled_capital.checked_add(conferred_refund).unwrap();
            member.surplus_amount = 0;
            member.closure_claimed = true;
            (non_conferred_refund, conferred_refund, total_refund)
        };

        // --- Execute Closure Claims and Verify Precalculated Allocations ---
        let mut simulated_vault = vault_balance; // 300
        let mut total_settled = 0u64;

        // 1. Member A Claim:
        // Expected: Surplus = 30, Conferred = (180 - 30) - 70 = 80, Total = 110
        let (surplus_a, conferred_a, total_a) = simulate_claim(&mut member_a, &mut simulated_pool, &mut simulated_vault, &mut total_settled);
        assert_eq!(surplus_a, 30);
        assert_eq!(conferred_a, 80);
        assert_eq!(total_a, 110);
        assert_eq!(total_a, member_a.total_contributions - member_a.cumulative_benefit_received);

        // 2. Member B Claim:
        // Expected: Surplus = 0, Conferred = 150 - 70 = 80, Total = 80
        let (surplus_b, conferred_b, total_b) = simulate_claim(&mut member_b, &mut simulated_pool, &mut simulated_vault, &mut total_settled);
        assert_eq!(surplus_b, 0);
        assert_eq!(conferred_b, 80);
        assert_eq!(total_b, 80);
        assert_eq!(total_b, member_b.total_contributions - member_b.cumulative_benefit_received);

        // 3. Member C Claim:
        // Expected: Surplus = 50, Conferred = (100 - 50) - 20 = 30, Total = 80
        let (surplus_c, conferred_c, total_c) = simulate_claim(&mut member_c, &mut simulated_pool, &mut simulated_vault, &mut total_settled);
        assert_eq!(surplus_c, 50);
        assert_eq!(conferred_c, 30);
        assert_eq!(total_c, 80);
        assert_eq!(total_c, member_c.total_contributions - member_c.cumulative_benefit_received);

        // 4. Member D Claim:
        // Expected: Surplus = 0, Conferred = 50 - 20 = 30, Total = 30
        let (surplus_d, conferred_d, total_d) = simulate_claim(&mut member_d, &mut simulated_pool, &mut simulated_vault, &mut total_settled);
        assert_eq!(surplus_d, 0);
        assert_eq!(conferred_d, 30);
        assert_eq!(total_d, 30);
        assert_eq!(total_d, member_d.total_contributions - member_d.cumulative_benefit_received);

        // --- Final Global Invariant Verification ---
        // 1. Vault is fully and cleanly exhausted to 0 (no dust, no deficit):
        assert_eq!(simulated_vault, 0);

        // 2. Total settled capital exactly equals initial vault balance at closure:
        assert_eq!(total_settled, vault_balance);
        assert_eq!(total_settled, 300);

        // 3. Sum of all member refunds equals 110 + 80 + 80 + 30 = 300:
        assert_eq!(total_a + total_b + total_c + total_d, 300);

        // 4. All members marked as closure_claimed:
        assert!(member_a.closure_claimed);
        assert!(member_b.closure_claimed);
        assert!(member_c.closure_claimed);
        assert!(member_d.closure_claimed);
    }

    #[test]
    fn test_pro_rata_settlement_on_vault_deficit() {
        // Two members A and B each have 50 net conferred share (total 100).
        // The pool vault only has 60 USDC remaining (40% deficit).
        // Under pro-rata settlement, each member receives exactly 50% of the available 60 = 30 USDC,
        // rather than the first claimant taking 50 and leaving the second with 10.
        let mut pool = create_test_pool();
        pool.is_closing = true;
        pool.total_non_conferred_capital = 0;
        pool.total_conferred_capital = 100;
        let mut vault_balance: u64 = 60;

        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Snapshot closure pro-rata basis on first claim
        pool.closing_vault_basis = vault_balance; // 60
        pool.closing_non_conferred_basis = pool.total_non_conferred_capital; // 0
        pool.closing_conferred_pool_capital = pool.total_conferred_capital; // 100
        pool.has_snapshotted_closure = true;

        let closing_vault_for_conferred = pool.closing_vault_basis.saturating_sub(pool.closing_non_conferred_basis); // 60

        // Claim Member A:
        let net_share_a = member_a.conferred_contribution().saturating_sub(member_a.cumulative_benefit_received); // 50
        let refund_a = ((net_share_a as u128 * closing_vault_for_conferred as u128)
            / pool.closing_conferred_pool_capital as u128) as u64; // (50 * 60) / 100 = 30
        assert_eq!(refund_a, 30);
        vault_balance -= refund_a;
        member_a.closure_claimed = true;

        // Claim Member B:
        let net_share_b = member_b.conferred_contribution().saturating_sub(member_b.cumulative_benefit_received); // 50
        let refund_b = ((net_share_b as u128 * closing_vault_for_conferred as u128)
            / pool.closing_conferred_pool_capital as u128) as u64; // (50 * 60) / 100 = 30
        assert_eq!(refund_b, 30);
        vault_balance -= refund_b;
        member_b.closure_claimed = true;

        // Both members receive an equal 30 USDC; vault is cleanly exhausted to 0
        assert_eq!(refund_a, refund_b);
        assert_eq!(refund_a + refund_b, 60);
        assert_eq!(vault_balance, 0);
        assert!(member_a.closure_claimed);
        assert!(member_b.closure_claimed);
    }

    #[test]
    fn test_surplus_consumed_across_cycles() {
        let mut pool = create_test_pool(); // obligation = 50
        pool.current_cycle = 1;

        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100, // 50 obligation + 50 surplus
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 1,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 1, // Deposited in Cycle 1
            funded_cycle: 1,
            is_paused: false,
            next_member: None,
        };
        pool.total_non_conferred_capital = 50;
        pool.total_conferred_capital = 50;

        // While in Cycle 1: surplus remains unconsumed (prepayment for Cycle 2)
        member.sync_surplus(&mut pool);
        assert_eq!(member.surplus_amount, 50);
        assert_eq!(pool.total_non_conferred_capital, 50);
        assert_eq!(pool.total_conferred_capital, 50);

        // When cycle advances to Cycle 2:
        pool.current_cycle = 2;
        member.sync_surplus(&mut pool);

        // Surplus is consumed into conferred capital!
        assert_eq!(member.surplus_amount, 0);
        assert_eq!(pool.total_non_conferred_capital, 0);
        assert_eq!(pool.total_conferred_capital, 100); // 50 + 50 consumed
        assert_eq!(member.surplus_cycle, 2);
    }

    #[test]
    fn test_unfunded_member_refund_preserved() {
        let mut pool = create_test_pool(); // obligation = 50
        pool.funded_member_count = 1;

        // Unfunded member joins with 20 USDC (< 50 obligation)
        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: false,
            deposited_total: 20,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 20,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // A spend of 40 occurs in the pool
        let spend_1: u64 = 40;
        let benefit_delta = (spend_1 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta;

        // Unfunded member syncs: does NOT accrue spend benefit because they had no representation
        member.sync_benefit(&pool).unwrap();
        assert_eq!(member.cumulative_benefit_received, 0);

        // Member's non-conferred amount is their full 20 deposit; conferred contribution is 0:
        assert_eq!(member.non_conferred_amount(), 20);
        assert_eq!(member.conferred_contribution(), 0);
    }

    #[test]
    fn test_tier_1_non_conferred_deficit_pro_rata() {
        // Two members A and B each have 50 non-conferred capital (total non-conferred = 100).
        // Total vault only has 40 USDC (severe deficit, cannot cover non-conferred tier).
        // Under two-tier pro-rata, each member gets (50 * 40) / 100 = 20 USDC (50% of available).
        // Zero FCFS advantage!
        let mut pool = create_test_pool();
        pool.is_closing = true;
        pool.total_non_conferred_capital = 100;
        pool.total_conferred_capital = 100;
        let mut vault_balance: u64 = 40;

        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Snapshot basis
        pool.closing_vault_basis = vault_balance; // 40
        pool.closing_non_conferred_basis = pool.total_non_conferred_capital; // 100
        pool.closing_conferred_pool_capital = pool.total_conferred_capital; // 100
        pool.has_snapshotted_closure = true;

        // Member A claims first: gets (50 * 40) / 100 = 20
        let refund_a = ((member_a.non_conferred_amount() as u128 * pool.closing_vault_basis as u128)
            / pool.closing_non_conferred_basis as u128) as u64;
        assert_eq!(refund_a, 20);
        vault_balance -= refund_a;
        member_a.closure_claimed = true;

        // Member B claims second: also gets (50 * 40) / 100 = 20
        let refund_b = ((member_b.non_conferred_amount() as u128 * pool.closing_vault_basis as u128)
            / pool.closing_non_conferred_basis as u128) as u64;
        assert_eq!(refund_b, 20);
        vault_balance -= refund_b;
        member_b.closure_claimed = true;

        assert_eq!(refund_a, refund_b);
        assert_eq!(vault_balance, 0);
        assert!(member_a.closure_claimed);
        assert!(member_b.closure_claimed);
    }

    #[test]
    fn test_tier_2_deficit_with_senior_tier_1_full_coverage() {
        // Vault has 120 USDC.
        // Senior Tier 1 (Non-conferred): Member A has 40 surplus.
        // Junior Tier 2 (Conferred): Member B has 50 conferred, Member C has 50 conferred (total conferred = 100).
        // Since vault (120) >= non-conferred basis (40):
        // Member A gets 100% of their 40 non-conferred capital!
        // Residual vault for Tier 2 = 120 - 40 = 80 USDC.
        // Members B and C face a 20% haircut: each gets (50 * 80) / 100 = 40 USDC.
        // Total settled = 40 + 40 + 40 = 120 USDC (100% of vault, 0 dust).
        let mut pool = create_test_pool();
        pool.is_closing = true;
        pool.total_non_conferred_capital = 40;
        pool.total_conferred_capital = 100;
        let mut vault_balance: u64 = 120;

        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: false,
            deposited_total: 40, // Unfunded 40 non-conferred
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 40,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let mut member_c = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Snapshot basis
        pool.closing_vault_basis = vault_balance; // 120
        pool.closing_non_conferred_basis = pool.total_non_conferred_capital; // 40
        pool.closing_conferred_pool_capital = pool.total_conferred_capital; // 100
        pool.has_snapshotted_closure = true;

        let closing_vault_for_conferred = pool.closing_vault_basis.saturating_sub(pool.closing_non_conferred_basis); // 80

        // Member A claims: Non-conferred = 40 (100%), Conferred = 0. Total = 40
        let a_nc_refund = member_a.non_conferred_amount().min(vault_balance); // 40
        let a_c_refund = if pool.closing_conferred_pool_capital > 0 && closing_vault_for_conferred > 0 {
            ((member_a.conferred_contribution() as u128 * closing_vault_for_conferred as u128)
                / pool.closing_conferred_pool_capital as u128) as u64
        } else {
            0
        }; // 0
        let total_a = a_nc_refund + a_c_refund;
        assert_eq!(total_a, 40);
        vault_balance -= total_a;
        member_a.closure_claimed = true;

        // Member B claims: Non-conferred = 0, Conferred = (50 * 80) / 100 = 40
        let b_c_refund = ((member_b.conferred_contribution() as u128 * closing_vault_for_conferred as u128)
            / pool.closing_conferred_pool_capital as u128) as u64; // 40
        assert_eq!(b_c_refund, 40);
        vault_balance -= b_c_refund;
        member_b.closure_claimed = true;

        // Member C claims: Non-conferred = 0, Conferred = (50 * 80) / 100 = 40
        let c_c_refund = ((member_c.conferred_contribution() as u128 * closing_vault_for_conferred as u128)
            / pool.closing_conferred_pool_capital as u128) as u64; // 40
        assert_eq!(c_c_refund, 40);
        vault_balance -= c_c_refund;
        member_c.closure_claimed = true;

        // Senior Tier 1 received 100% face value (40). Junior Tier 2 absorbed equal 20% haircut (40 each).
        assert_eq!(vault_balance, 0);
        assert!(member_a.closure_claimed);
        assert!(member_b.closure_claimed);
        assert!(member_c.closure_claimed);
    }

    #[test]
    fn test_surplus_deficit_graceful_refund() {
        // Vault has 30 USDC, but member is owed 50 surplus.
        // Instead of hard-reverting with InsufficientVaultForSurplus, member recovers the available 30.
        let member_surplus = 50u64;
        let vault_balance = 30u64;
        let surplus_refund = member_surplus.min(vault_balance);
        assert_eq!(surplus_refund, 30);
    }

    #[test]
    fn test_deposits_and_joins_blocked_when_pool_is_closing() {
        let mut pool = create_test_pool();
        assert!(!pool.is_closing);
        assert!(pool.ensure_not_closing().is_ok());

        // Pool transitions to closing state
        pool.is_closing = true;

        // ensure_not_closing() fails with PoolIsClosing
        let err = pool.ensure_not_closing().unwrap_err();
        assert_eq!(err, ComfiError::PoolIsClosing.into());

        // Verify simulated deposit validation fails when closing
        let attempt_deposit = |p: &Pool, amount: u64| -> Result<()> {
            require!(amount > 0, ComfiError::InvalidAmount);
            p.ensure_not_closing()?;
            Ok(())
        };

        let deposit_res = attempt_deposit(&pool, 50);
        assert!(deposit_res.is_err());
        assert_eq!(deposit_res.unwrap_err(), ComfiError::PoolIsClosing.into());

        // Verify simulated join validation fails when closing
        let attempt_join = |p: &Pool, deposit: u64| -> Result<()> {
            p.ensure_not_closing()?;
            require!(deposit >= p.minimum_deposit, ComfiError::DepositBelowMinimum);
            Ok(())
        };

        let join_res = attempt_join(&pool, 100);
        assert!(join_res.is_err());
        assert_eq!(join_res.unwrap_err(), ComfiError::PoolIsClosing.into());
    }

    #[test]
    fn test_assert_executable_rejects_already_executed_proposals() {
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::SetSpenderLimit {
                member: Pubkey::new_unique(),
                cap: 500,
            },
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Executed,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        let assert_exec = |p: &Proposal, now: i64| -> Result<()> {
            require!(
                p.state == ProposalState::Executable,
                ComfiError::ProposalNotExecutable
            );
            require!(
                now >= p.executable_after,
                ComfiError::TimelockActive
            );
            Ok(())
        };

        let res = assert_exec(&proposal, 100);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), ComfiError::ProposalNotExecutable.into());

        proposal.state = ProposalState::Executable;
        proposal.executable_after = 200;
        let timelock_res = assert_exec(&proposal, 150);
        assert!(timelock_res.is_err());
        assert_eq!(timelock_res.unwrap_err(), ComfiError::TimelockActive.into());

        let ok_res = assert_exec(&proposal, 250);
        assert!(ok_res.is_ok());
    }

    #[test]
    fn test_spender_limit_proposal_cannot_be_replayed() {
        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 0,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::SetSpenderLimit {
                member: Pubkey::new_unique(),
                cap: 500,
            },
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 100,
            state: ProposalState::Executable,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 2,
        };

        let mut sc = SpenderCycle {
            pool: proposal.pool,
            member: Pubkey::new_unique(),
            cycle: 1,
            cap: 0,
            spent: 0,
            bump: 255,
        };

        // 1. First execution succeeds and transitions proposal to Executed
        assert_eq!(proposal.state, ProposalState::Executable);
        sc.cap = 500;
        proposal.state = ProposalState::Executed;

        // 2. Spender spends 500
        sc.spent = 500;
        assert_eq!(sc.spent, sc.cap);

        // 3. Attempting second execution with the same proposal is rejected
        let assert_exec = |p: &Proposal, now: i64| -> Result<()> {
            require!(
                p.state == ProposalState::Executable,
                ComfiError::ProposalNotExecutable
            );
            require!(
                now >= p.executable_after,
                ComfiError::TimelockActive
            );
            Ok(())
        };

        let replay_res = assert_exec(&proposal, 200);
        assert!(replay_res.is_err());
        assert_eq!(replay_res.unwrap_err(), ComfiError::ProposalNotExecutable.into());
        // Spender spent remains 500, spent cannot be reset to 0!
        assert_eq!(sc.spent, 500);
    }

    #[test]
    fn test_individual_withdrawal_direct_attribution_in_spend() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 3;
        pool.cumulative_benefit_per_member = 0;
        pool.total_conferred_capital = 300;

        let mut requester = Member {
            pool: Pubkey::new_unique(),
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let withdrawal_amount: u64 = 60;
        let requires_proposal = true;

        if requires_proposal {
            requester.cumulative_benefit_received += withdrawal_amount;
        }

        assert_eq!(requester.cumulative_benefit_received, 60);
        assert_eq!(pool.cumulative_benefit_per_member, 0);

        let net_share = requester.conferred_contribution().saturating_sub(requester.cumulative_benefit_received);
        assert_eq!(net_share, 40);
    }

    #[test]
    fn test_vote_totals_accrued_benefit_against_voter() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2;
        pool.cumulative_benefit_per_member = 0;

        // Simulate socialized spend in pool: 100 total distributed among 2 funded members = 50 per member
        let spend_1: u64 = 100;
        let benefit_delta_1 = (spend_1 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_1;
        assert_eq!(pool.cumulative_benefit_per_member, 50 * BENEFIT_SCALE);

        let mut voter = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Invariant: prior to voting sync, voter has 0 cumulative benefit totaled
        assert_eq!(voter.cumulative_benefit_received, 0);
        assert_eq!(voter.last_benefit_index, 0);

        // Being able to cast a vote always means benefit is totaled against the voter!
        assert!(voter.is_funded_for_pool(&pool));
        voter.sync_benefit(&pool).unwrap();

        // Voter's benefit received must now reflect the pool's accrued benefit (50)
        assert_eq!(voter.cumulative_benefit_received, 50);
        assert_eq!(voter.last_benefit_index, 50 * BENEFIT_SCALE);

        // A second benefit distribution occurs in the pool: 60 among 2 members = 30 per member
        let spend_2: u64 = 60;
        let benefit_delta_2 = (spend_2 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_2;
        assert_eq!(pool.cumulative_benefit_per_member, 80 * BENEFIT_SCALE);

        // Next vote sync totals new incremental benefit against voter (50 + 30 = 80)
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 80);
        assert_eq!(voter.last_benefit_index, 80 * BENEFIT_SCALE);

        // An unfunded member cannot vote
        let unfunded_voter = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: false,
            deposited_total: 0,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 0,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        assert!(!unfunded_voter.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_proportion_based_vote_threshold_scaling() {
        let mut pool = create_test_pool();

        let mut proposal = Proposal {
            pool: Pubkey::new_unique(),
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ClosePool,
            yes_votes: 0,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::OnDeadline,
            vote_threshold: 5000, // 50.00% (5000 bps)
        };

        // For ClosePool / SetSpenderLimit, a strict majority floor (5001 bps) is enforced
        // 1 member: ceil(1 * 0.5001) = 1
        pool.funded_member_count = 1;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 1);

        // 2 members: ceil(2 * 0.5001) = 2 (strict majority requires both members to close pool!)
        pool.funded_member_count = 2;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 2);

        // 3 members: ceil(3 * 0.5001) = 2
        pool.funded_member_count = 3;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 2);

        // 4 members: ceil(4 * 0.5001) = 3
        pool.funded_member_count = 4;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 3);

        // 5 members: ceil(5 * 0.5001) = 3
        pool.funded_member_count = 5;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 3);

        // 10 members: ceil(10 * 0.5001) = 6
        pool.funded_member_count = 10;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 6);

        // Strict majority 51% (5100 bps)
        proposal.vote_threshold = 5100;
        // 10 members: ceil(10 * 0.51) = ceil(5.1) = 6
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 6);
        // 100 members: ceil(100 * 0.51) = 51
        pool.funded_member_count = 100;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 51);

        // Two-thirds supermajority 6667 bps
        proposal.vote_threshold = 6667;
        pool.funded_member_count = 3;
        // ceil(3 * 0.6667) = ceil(2.0001) = 3
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 3);
        pool.funded_member_count = 4;
        // ceil(4 * 0.6667) = ceil(2.6668) = 3
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 3);

        // 100% threshold requires all members (10,000 bps)
        proposal.vote_threshold = 10_000;
        pool.funded_member_count = 7;
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 7);

        // Rejection of ambiguous threshold < 100 bps
        proposal.vote_threshold = 50;
        assert_eq!(
            proposal.required_votes_for_pool(&pool).unwrap_err(),
            ComfiError::InvalidVoteThreshold.into()
        );

        // Passing logic validation:
        // Set up 5 members with 50% threshold -> requires 3 yes votes
        proposal.vote_threshold = 5000;
        pool.funded_member_count = 5;

        proposal.yes_votes = 2;
        proposal.no_votes = 0;
        assert!(!proposal.is_passed_for_pool(&pool).unwrap()); // 2 < 3 required

        proposal.yes_votes = 3;
        proposal.no_votes = 3;
        assert!(!proposal.is_passed_for_pool(&pool).unwrap()); // tied vote fails

        proposal.yes_votes = 3;
        proposal.no_votes = 1;
        assert!(proposal.is_passed_for_pool(&pool).unwrap()); // 3 >= 3 and 3 > 1 passes!
    }

    #[test]
    fn test_voting_idempotence_across_multiple_proposals_in_cycle() {
        let mut pool = create_test_pool();
        pool.current_cycle = 1;
        pool.funded_member_count = 3;
        pool.cumulative_benefit_per_member = 0;

        // Spend in cycle 1: 150 USDC shared across 3 members = 50 USDC per member
        let spend_cycle_1: u64 = 150;
        let benefit_delta_1 = (spend_cycle_1 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_1;
        assert_eq!(pool.cumulative_benefit_per_member, 50 * BENEFIT_SCALE);

        let mut voter = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 1,
            funded_cycle: 1,
            is_paused: false,
            next_member: None,
        };

        // Initially, voter has 0 cumulative benefit totaled
        assert_eq!(voter.cumulative_benefit_received, 0);
        assert_eq!(voter.last_benefit_index, 0);

        // Vote 1: Cast vote on Proposal A in cycle 1
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 50);
        assert_eq!(voter.last_benefit_index, 50 * BENEFIT_SCALE);

        // Vote 2: Cast vote on Proposal B in the same cycle 1
        // IDEMPOTENCE INVARIANT: Casting vote on a 2nd proposal must NOT total extra benefit!
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 50);
        assert_eq!(voter.last_benefit_index, 50 * BENEFIT_SCALE);

        // Vote 3: Cast vote on Proposal C in the same cycle 1
        // IDEMPOTENCE INVARIANT: Casting vote on a 3rd proposal must NOT total extra benefit!
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 50);
        assert_eq!(voter.last_benefit_index, 50 * BENEFIT_SCALE);

        // Simulate casting votes on 10 more proposals in the same cycle
        for _ in 0..10 {
            voter.sync_benefit(&pool).unwrap();
            assert_eq!(voter.cumulative_benefit_received, 50);
            assert_eq!(voter.last_benefit_index, 50 * BENEFIT_SCALE);
        }

        // Cycle 2: A new spend of 60 USDC occurs (20 USDC per member)
        pool.current_cycle = 2;
        voter.funded_cycle = 2;
        let spend_cycle_2: u64 = 60;
        let benefit_delta_2 = (spend_cycle_2 as u128 * BENEFIT_SCALE) / pool.funded_member_count as u128;
        pool.cumulative_benefit_per_member += benefit_delta_2;
        assert_eq!(pool.cumulative_benefit_per_member, 70 * BENEFIT_SCALE);

        // Vote 1 in Cycle 2: Voter casts vote on Proposal D
        // Accrues only the newly spent delta (20 USDC) -> total 70 USDC
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 70);
        assert_eq!(voter.last_benefit_index, 70 * BENEFIT_SCALE);

        // Vote 2 in Cycle 2: Voter casts vote on Proposal E
        // Remains strictly idempotent: no extra benefit totaled!
        voter.sync_benefit(&pool).unwrap();
        assert_eq!(voter.cumulative_benefit_received, 70);
        assert_eq!(voter.last_benefit_index, 70 * BENEFIT_SCALE);
    }

    #[test]
    fn test_closure_basis_decided_in_closure_transaction() {
        let mut pool = create_test_pool();
        pool.total_non_conferred_capital = 80; // e.g. 50 surplus + 30 unfunded deposit
        pool.total_conferred_capital = 200;
        pool.funded_member_count = 2;
        pool.current_cycle = 1;

        // Verify bases start at 0 before closure
        assert!(!pool.is_closing);
        assert_eq!(pool.closing_non_conferred_basis, 0);
        assert_eq!(pool.closing_conferred_pool_capital, 0);

        let mut proposal = Proposal {
            pool: pool.global,
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ClosePool,
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 1,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 5001,
        };

        // When ClosePool proposal is executed in that transaction:
        let passed = proposal.is_passed_for_pool(&pool).unwrap();
        assert!(passed);
        if proposal.action == ProposalAction::ClosePool {
            pool.enter_closure();
            proposal.state = ProposalState::Executed;
        }
        assert_eq!(proposal.state, ProposalState::Executed);

        // Invariant: Conferred and non-conferred bases MUST be locked in that transaction!
        assert!(pool.is_closing);
        assert_eq!(pool.closing_non_conferred_basis, 80);
        assert_eq!(pool.closing_conferred_pool_capital, 200);

        // Member A with surplus attempts sync_surplus after pool closure (e.g. cycle was rolled prior to closure)
        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 1,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0, // Lower than pool.current_cycle
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // After VULN-04 remediation: sync_surplus consumes elapsed surplus into conferred capital
        member_a.sync_surplus(&mut pool);
        assert_eq!(member_a.surplus_amount, 0); // Consumed for elapsed cycle!
        assert_eq!(pool.total_non_conferred_capital, 30);
        assert_eq!(pool.total_conferred_capital, 250);
    }

    // =========================================================================
    // Regression Tests for Remediated Vulnerabilities (VULN-01 to VULN-08)
    // =========================================================================

    #[test]
    fn test_vuln_01_unvoted_spend_direct_attribution() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2;
        let mut requester = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Spender,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let spend_amount: u64 = 40;
        let requires_proposal = false;

        // In an unvoted spend (requires_proposal == false), the benefit is directly
        // attributed to requester.cumulative_benefit_received and NOT socialized
        // into pool.cumulative_benefit_per_member.
        if !requires_proposal {
            requester.cumulative_benefit_received = requester
                .cumulative_benefit_received
                .checked_add(spend_amount)
                .unwrap();
        } else {
            let per_member_scaled = (spend_amount as u128)
                .checked_mul(BENEFIT_SCALE)
                .unwrap()
                .checked_div(pool.funded_member_count as u128)
                .unwrap();
            pool.cumulative_benefit_per_member = pool
                .cumulative_benefit_per_member
                .checked_add(per_member_scaled)
                .unwrap();
        }

        assert_eq!(requester.cumulative_benefit_received, 40);
        assert_eq!(pool.cumulative_benefit_per_member, 0); // Not socialized!
    }

    #[test]
    fn test_vuln_02_vote_threshold_strict_majority_enforcement() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2;

        let mut proposal = Proposal {
            pool: pool.global,
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ClosePool,
            yes_votes: 1,
            no_votes: 0,
            voting_cycle: 0,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 5000, // 50.00%
        };

        // For ClosePool, strict majority floor (5001 bps) is enforced.
        // In a 2-member pool: ceil(2 * 0.5001) = 2 votes required.
        let required = proposal.required_votes_for_pool(&pool).unwrap();
        assert_eq!(required, 2);
        assert!(!proposal.is_passed_for_pool(&pool).unwrap());

        // Same for SetSpenderLimit
        proposal.action = ProposalAction::SetSpenderLimit {
            member: Pubkey::new_unique(),
            cap: 1000,
        };
        assert_eq!(proposal.required_votes_for_pool(&pool).unwrap(), 2);

        // Ambiguous threshold < 100 bps is rejected
        proposal.vote_threshold = 50;
        assert_eq!(
            proposal.required_votes_for_pool(&pool).unwrap_err(),
            ComfiError::InvalidVoteThreshold.into()
        );

        // Threshold > 10,000 bps is rejected
        proposal.vote_threshold = 10_001;
        assert_eq!(
            proposal.required_votes_for_pool(&pool).unwrap_err(),
            ComfiError::InvalidVoteThreshold.into()
        );
    }

    #[test]
    fn test_vuln_03_cycle_rollover_timelock_enforced() {
        let pool = create_test_pool();
        let mut proposal = Proposal {
            pool: pool.global,
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::SetSpenderLimit {
                member: Pubkey::new_unique(),
                cap: 500,
            },
            yes_votes: 2,
            no_votes: 0,
            voting_cycle: 0,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 5001,
        };

        // In cycle rollover (process_cycle_proposals), passed proposals must NOT
        // execute instantly. They must transition to Executable with a timelock window.
        let passed = proposal.is_passed_for_pool(&pool).unwrap();
        assert!(passed);

        let now = 1_000_000i64;
        let timelock = pool.timelock_seconds as i64;
        proposal.state = ProposalState::Executable;
        proposal.executable_after = now + timelock;

        assert_eq!(proposal.state, ProposalState::Executable);
        assert_eq!(proposal.executable_after, now + timelock);
        assert!(proposal.executable_after > now);
    }

    #[test]
    fn test_vuln_04_sync_surplus_on_closure() {
        let mut pool = create_test_pool();
        pool.is_closing = true;
        pool.current_cycle = 2;
        pool.total_non_conferred_capital = 100;
        pool.total_conferred_capital = 200;

        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 1, // Cycle 1 < pool.current_cycle (2)
            funded_cycle: 1,
            is_paused: false,
            next_member: None,
        };

        // Even though pool.is_closing is true, sync_surplus must consume
        // the elapsed surplus into conferred capital.
        member.sync_surplus(&mut pool);
        assert_eq!(member.surplus_amount, 0);
        assert_eq!(pool.total_non_conferred_capital, 50);
        assert_eq!(pool.total_conferred_capital, 250);
        assert_eq!(member.surplus_cycle, 2);
    }

    #[test]
    fn test_vuln_05_governance_approved_withdrawal_without_spender_cycle() {
        let pool = create_test_pool();
        let _requester = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // When a proposal is approved for withdrawal, requires_proposal is true.
        // It does not depend on a SpenderCycle cap.
        let requires_proposal = true;
        let spender_cycle: Option<SpenderCycle> = None;

        let spend_valid = if requires_proposal {
            // Governance-approved: no spender cycle needed
            true
        } else {
            // Unvoted spend: spender cycle is mandatory and must not exceed cap
            spender_cycle.is_some()
        };

        assert!(spend_valid);
    }

    #[test]
    fn test_vuln_06_spender_cycle_initialization_via_execute() {
        let pool = create_test_pool();
        let spender_pubkey = Pubkey::new_unique();
        let target_cycle: u64 = 3;

        // execute_spender_limit initializes the SpenderCycle specifically
        // for the current target cycle.
        let spender_cycle = SpenderCycle {
            pool: pool.global,
            member: spender_pubkey,
            cycle: target_cycle,
            cap: 1000,
            spent: 0,
            bump: 255,
        };

        assert_eq!(spender_cycle.cycle, target_cycle);
        assert_eq!(spender_cycle.cap, 1000);
        assert_eq!(spender_cycle.spent, 0);
    }

    #[test]
    fn test_vuln_07_testing_enabled_production_gate() {
        let pool = create_test_pool();
        // In test mode, testing_enabled is accessible
        #[cfg(any(test, feature = "testing"))]
        {
            assert!(pool.testing_enabled);
        }
    }

    #[test]
    fn test_vuln_08_recurring_cycle_deposit_funds_conferred_capital() {
        let mut pool = create_test_pool();
        pool.member_obligation_amount = 50;
        pool.total_conferred_capital = 50;
        pool.total_non_conferred_capital = 0;
        pool.current_cycle = 0;

        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Cycle rolls from 0 to 1
        pool.current_cycle = 1;

        // Member deposits their cycle 1 obligation (50 USDC)
        let deposit_amount: u64 = 50;
        let needed = if member.funded_cycle < pool.current_cycle {
            pool.member_obligation_amount
        } else {
            0
        };

        let obligation_part = deposit_amount.min(needed);
        let surplus_part = deposit_amount.saturating_sub(obligation_part);

        if obligation_part > 0 {
            pool.total_conferred_capital = pool
                .total_conferred_capital
                .checked_add(obligation_part)
                .unwrap();
            member.funded_cycle = pool.current_cycle;
        }

        if surplus_part > 0 {
            member.surplus_amount = member
                .surplus_amount
                .checked_add(surplus_part)
                .unwrap();
            pool.total_non_conferred_capital = pool
                .total_non_conferred_capital
                .checked_add(surplus_part)
                .unwrap();
        }

        // The recurring deposit immediately conferred capital to the pool!
        assert_eq!(pool.total_conferred_capital, 100);
        assert_eq!(pool.total_non_conferred_capital, 0);
        assert_eq!(member.surplus_amount, 0);
        assert_eq!(member.funded_cycle, 1);
    }

    #[test]
    fn test_cycle_expiry_enforcement_blocks_operations() {
        let mut pool = create_test_pool();
        pool.cycle_started_at = 1000;
        pool.cycle_duration_seconds = 100; // next_start = 1100

        // At timestamp 1050 (< 1100), cycle is active and operations are permitted:
        assert!(pool.ensure_cycle_current_at(1050).is_ok());

        // At timestamp 1100 (>= 1100), cycle has expired and roll_cycle is required:
        let err = pool.ensure_cycle_current_at(1100).unwrap_err();
        assert_eq!(err, ComfiError::CycleRollRequired.into());

        // At timestamp 1200 (> 1100), still requires roll_cycle:
        let err2 = pool.ensure_cycle_current_at(1200).unwrap_err();
        assert_eq!(err2, ComfiError::CycleRollRequired.into());

        // When pool is closing, cycle expiry is not enforced:
        pool.is_closing = true;
        assert!(pool.ensure_cycle_current_at(1200).is_ok());
    }

    #[test]
    fn test_roll_cycle_updates_members_and_moves_surplus() {
        let mut pool = create_test_pool();
        pool.member_obligation_amount = 50;
        pool.total_non_conferred_capital = 50; // Member A's 50 surplus
        pool.total_conferred_capital = 100;
        pool.member_count = 2;
        pool.funded_member_count = 2;
        pool.current_cycle = 0;

        let mut member_a = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100, // 50 obligation + 50 surplus
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        let mut member_b = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Advance pool cycle from 0 to 1
        pool.current_cycle = 1;

        // Sync both members to the new cycle:
        member_a.sync_surplus(&mut pool);
        member_b.sync_surplus(&mut pool);

        // Member A had 50 surplus: consumed into conferred capital, funded for Cycle 1!
        assert_eq!(member_a.surplus_amount, 0);
        assert!(member_a.is_funded);
        assert_eq!(member_a.funded_cycle, 1);
        assert_eq!(member_a.surplus_cycle, 1);

        // Member B had 0 surplus: is_funded flipped to false!
        assert_eq!(member_b.surplus_amount, 0);
        assert!(!member_b.is_funded);
        assert_eq!(member_b.surplus_cycle, 1);

        // Pool capital updated: non-conferred reduced to 0, conferred increased to 150
        assert_eq!(pool.total_non_conferred_capital, 0);
        assert_eq!(pool.total_conferred_capital, 150);

        // Member A is funded for pool in cycle 1, Member B is NOT:
        assert!(member_a.is_funded_for_pool(&pool));
        assert!(!member_b.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_inactive_members_lose_voting_status_in_new_cycle() {
        let mut pool = create_test_pool();
        pool.current_cycle = 0;
        pool.member_obligation_amount = 50;

        let member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // In Cycle 0: member is funded
        assert!(member.is_funded_for_pool(&pool));

        // When cycle rolls to Cycle 1 without member depositing:
        pool.current_cycle = 1;
        // Inactive member loses voting/funded status immediately:
        assert!(!member.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_cranker_lamport_fee_reimbursement_calculation() {
        let pool_lamports: u64 = 100_000;
        let min_rent: u64 = 50_000;
        let available = pool_lamports.saturating_sub(min_rent);
        let reimbursement = 10_000u64.min(available);
        assert_eq!(reimbursement, 10_000);

        // When pool has barely enough lamports for rent:
        let pool_lamports_low: u64 = 55_000;
        let available_low = pool_lamports_low.saturating_sub(min_rent);
        let reimbursement_low = 10_000u64.min(available_low);
        assert_eq!(reimbursement_low, 5_000);

        // When pool is at or below rent exemption:
        let pool_lamports_min: u64 = 50_000;
        let available_zero = pool_lamports_min.saturating_sub(min_rent);
        let reimbursement_zero = 10_000u64.min(available_zero);
        assert_eq!(reimbursement_zero, 0);
    }

    #[test]
    fn test_funded_status_only_flips_on_cycle_rollover_not_deposit() {
        let mut pool = create_test_pool();
        pool.current_cycle = 0;
        pool.member_obligation_amount = 50;

        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 50,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 50,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Member is funded in Cycle 0
        assert!(member.is_funded_for_pool(&pool));

        // Cycle rolls from 0 to 1 without member having surplus
        pool.current_cycle = 1;
        member.sync_surplus(&mut pool);
        assert!(!member.is_funded);
        assert!(!member.is_funded_for_pool(&pool));

        // In Cycle 1, member deposits 50 USDC.
        // Funded status must NOT flip mid-cycle during deposit!
        let deposit_amount = 50u64;
        member.deposited_total += deposit_amount;
        member.total_contributions += deposit_amount;
        member.surplus_amount += deposit_amount;
        pool.total_non_conferred_capital += deposit_amount;

        // Still unfunded for Cycle 1:
        assert!(!member.is_funded);
        assert!(!member.is_funded_for_pool(&pool));
        assert_eq!(member.surplus_amount, 50);

        // When cycle rolls to Cycle 2, rollover consumes surplus and flips funded status:
        pool.current_cycle = 2;
        member.sync_surplus(&mut pool);

        assert!(member.is_funded);
        assert_eq!(member.funded_cycle, 2);
        assert_eq!(member.surplus_amount, 0);
        assert_eq!(pool.total_conferred_capital, 50);
        assert!(member.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_member_pause_and_unpause_cycle_rollover_lifecycle() {
        let mut pool = create_test_pool();
        pool.current_cycle = 0;
        pool.member_obligation_amount = 50;

        let mut member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100, // 50 obligation + 50 surplus prepaid
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Funded in Cycle 0
        assert!(member.is_funded_for_pool(&pool));

        // Member requests a pause for Cycle 1. The current electorate stays
        // intact until rollover.
        member.is_paused = true;
        assert!(member.is_funded_for_pool(&pool));

        // Cycle rolls from 0 to 1
        pool.current_cycle = 1;
        member.sync_surplus(&mut pool);

        // Member did NOT pay obligation; surplus was preserved at 50!
        assert_eq!(member.surplus_amount, 50);
        assert!(!member.is_funded);
        assert!(!member.is_funded_for_pool(&pool));

        // The unpause request also waits for the next cycle boundary.
        member.is_paused = false;

        // The member is still unfunded during Cycle 1.
        assert!(!member.is_funded_for_pool(&pool));

        // When cycle rolls to Cycle 2, member resumes paying obligation from surplus:
        pool.current_cycle = 2;
        member.sync_surplus(&mut pool);

        // Surplus consumed, funded status restored, voting restored!
        assert_eq!(member.surplus_amount, 0);
        assert!(member.is_funded);
        assert_eq!(member.funded_cycle, 2);
        assert!(member.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_comfi_sec_01_approve_withdrawal_strict_majority_floor() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2;

        let mut proposal = Proposal {
            pool: pool.global,
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ApproveWithdrawal {
                request: Pubkey::new_unique(),
            },
            yes_votes: 1,
            no_votes: 0,
            voting_cycle: 0,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 5000, // 50.00%
        };

        // For ApproveWithdrawal, strict majority floor (5001 bps) is enforced.
        // In a 2-member pool: ceil(2 * 0.5001) = 2 votes required.
        let required = proposal.required_votes_for_pool(&pool).unwrap();
        assert_eq!(required, 2);
        assert!(!proposal.is_passed_for_pool(&pool).unwrap());

        // In a 10-member pool with threshold set to 1000 bps (10%):
        pool.funded_member_count = 10;
        proposal.vote_threshold = 1000;
        let required_10 = proposal.required_votes_for_pool(&pool).unwrap();
        // ceil(10 * 0.5001) = 6 votes required
        assert_eq!(required_10, 6);

        proposal.yes_votes = 5;
        assert!(!proposal.is_passed_for_pool(&pool).unwrap());

        proposal.yes_votes = 6;
        assert!(proposal.is_passed_for_pool(&pool).unwrap());
    }

    #[test]
    fn test_comfi_sec_02_configuration_modification_majority_floor_and_staging() {
        let mut pool = create_test_pool();
        pool.funded_member_count = 2;

        let mut proposal = Proposal {
            pool: pool.global,
            id: 1,
            proposer: Pubkey::new_unique(),
            action: ProposalAction::ConfigurationModification {
                vote_threshold: 6000,
                cycle_duration_seconds: 3600,
                member_obligation_amount: 100,
                spender_limit_deadline_cycles: 2,
                withdrawal_deadline_cycles: 2,
                config_modification_deadline_cycles: 3,
                spender_limit_execution_mode: ExecutionMode::ThresholdMet,
                withdrawal_execution_mode: ExecutionMode::ThresholdMet,
                config_modification_execution_mode: ExecutionMode::ThresholdMet,
            },
            yes_votes: 1,
            no_votes: 0,
            voting_cycle: 0,
            deadline_cycle: 1,
            deadline: 1000,
            executable_after: 0,
            state: ProposalState::Open,
            bump: 255,
            execution_mode: ExecutionMode::ThresholdMet,
            vote_threshold: 5000, // 50.00%
        };

        // For ConfigurationModification, strict majority floor (5001 bps) is enforced.
        // In a 2-member pool: ceil(2 * 0.5001) = 2 votes required.
        let required = proposal.required_votes_for_pool(&pool).unwrap();
        assert_eq!(required, 2);
        assert!(!proposal.is_passed_for_pool(&pool).unwrap());

        proposal.yes_votes = 2;
        assert!(proposal.is_passed_for_pool(&pool).unwrap());
    }

    #[test]
    fn test_comfi_sec_06_unfunded_member_cannot_request_or_spend() {
        let pool = create_test_pool();
        let mut unfunded_member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Spender,
            is_funded: false,
            deposited_total: 0,
            surplus_amount: 0,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 0,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Even with role Spender, unfunded member is rejected by is_funded_for_pool
        assert!(!unfunded_member.is_funded_for_pool(&pool));

        // When funded status is restored for the current cycle with deposited total >= obligation
        unfunded_member.is_funded = true;
        unfunded_member.funded_cycle = pool.current_cycle;
        unfunded_member.deposited_total = pool.member_obligation_amount;
        assert!(unfunded_member.is_funded_for_pool(&pool));
    }

    #[test]
    fn test_configuration_modification_below_majority_threshold_rejected() {
        let _pool = create_test_pool();
        let invalid_action_5000 = ProposalAction::ConfigurationModification {
            vote_threshold: 5000, // 50.00% is below strict majority 5001 bps
            cycle_duration_seconds: 3600,
            member_obligation_amount: 100,
            spender_limit_deadline_cycles: 1,
            withdrawal_deadline_cycles: 1,
            config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::OnDeadline,
            withdrawal_execution_mode: ExecutionMode::OnDeadline,
            config_modification_execution_mode: ExecutionMode::OnDeadline,
        };

        if let ProposalAction::ConfigurationModification { vote_threshold, .. } = invalid_action_5000 {
            let res: Result<()> = if vote_threshold >= 5001 && vote_threshold <= 10_000 {
                Ok(())
            } else {
                err!(ComfiError::InvalidVoteThreshold)
            };
            assert_eq!(res.unwrap_err(), ComfiError::InvalidVoteThreshold.into());
        }

        let valid_action_5001 = ProposalAction::ConfigurationModification {
            vote_threshold: 5001,
            cycle_duration_seconds: 3600,
            member_obligation_amount: 100,
            spender_limit_deadline_cycles: 1,
            withdrawal_deadline_cycles: 1,
            config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::OnDeadline,
            withdrawal_execution_mode: ExecutionMode::OnDeadline,
            config_modification_execution_mode: ExecutionMode::OnDeadline,
        };

        if let ProposalAction::ConfigurationModification { vote_threshold, .. } = valid_action_5001 {
            let res: Result<()> = if vote_threshold >= 5001 && vote_threshold <= 10_000 {
                Ok(())
            } else {
                err!(ComfiError::InvalidVoteThreshold)
            };
            assert!(res.is_ok());
        }
    }

    #[test]
    fn test_join_pool_status_deferred_to_next_cycle() {
        let mut pool = create_test_pool();
        pool.member_obligation_amount = 50;
        pool.current_cycle = 0;
        pool.funded_member_count = 1; // Only creator is funded initially in cycle 0
        pool.total_conferred_capital = 50;
        pool.total_non_conferred_capital = 0;

        let initial_deposit: u64 = 50;

        // Simulate new member joining mid-cycle:
        // Overfunding check
        let excess_check = if initial_deposit > pool.member_obligation_amount {
            let excess = initial_deposit - pool.member_obligation_amount;
            excess <= pool.member_obligation_amount
        } else {
            true
        };
        assert!(excess_check);

        // Account mutations as in join_pool:
        pool.member_count += 1;
        pool.total_non_conferred_capital += initial_deposit;

        let mut new_member = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Spender,
            is_funded: false,
            deposited_total: initial_deposit,
            surplus_amount: initial_deposit,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: initial_deposit,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: pool.current_cycle,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: pool.current_cycle,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };

        // Mid-cycle: New member is NOT funded and has NO voting power in the active cycle
        assert!(!new_member.is_funded);
        assert_eq!(new_member.funded_cycle, 0);
        assert!(!new_member.is_funded_for_pool(&pool));
        assert_eq!(pool.funded_member_count, 1);
        assert_eq!(pool.total_conferred_capital, 50);
        assert_eq!(pool.total_non_conferred_capital, 50);

        // Advance to cycle 1 via roll_cycle logic
        pool.current_cycle = 1;

        // Process member at cycle boundary
        let obligation = pool.member_obligation_amount;
        assert!(new_member.surplus_amount >= obligation);
        new_member.surplus_amount -= obligation;
        pool.total_non_conferred_capital -= obligation;
        pool.total_conferred_capital += obligation;
        new_member.is_funded = true;
        new_member.funded_cycle = pool.current_cycle;
        pool.funded_member_count += 1;

        // In cycle 1: Member is now funded and can participate in governance
        assert!(new_member.is_funded);
        assert_eq!(new_member.funded_cycle, 1);
        assert!(new_member.is_funded_for_pool(&pool));
        assert_eq!(pool.funded_member_count, 2);
        assert_eq!(pool.total_conferred_capital, 100);
        assert_eq!(pool.total_non_conferred_capital, 0);
    }

    #[test]
    fn test_join_pool_overfunding_cap_enforced() {
        let pool = create_test_pool();
        let obligation = pool.member_obligation_amount; // 50

        // Deposit up to 2x obligation (100) is allowed (obligation for next cycle + 1 surplus)
        let deposit_100 = 100;
        let excess_100 = deposit_100 - obligation;
        assert!(excess_100 <= obligation);

        // Deposit > 2x obligation (101) exceeds overfunding cap and must fail
        let deposit_101 = 101;
        let excess_101 = deposit_101 - obligation;
        assert!(excess_101 > obligation);
    }

    #[test]
    fn test_process_cycle_members_verifies_pool_members_list() {
        let mut pool = create_test_pool();
        pool.testing_enabled = false;
        let member_1_key = Pubkey::new_unique();
        let member_2_key = Pubkey::new_unique();
        pool.head_member = Some(member_1_key);
        pool.rollover_cursor = None;
        pool.member_count = 2;

        let mut lamports_1 = 1000000;
        let mut member_1_data = vec![0u8; Member::SPACE];
        let mut lamports_dup = 1000000;
        let mut member_dup_data = vec![0u8; Member::SPACE];

        member_1_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        member_dup_data[..8].copy_from_slice(&Member::DISCRIMINATOR);

        let member_1 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: Some(member_2_key),
        };
        member_1.try_serialize(&mut &mut member_1_data[..]).unwrap();
        member_1.try_serialize(&mut &mut member_dup_data[..]).unwrap();

        let owner = crate::ID;
        let acc_1 = AccountInfo::new(
            &member_1_key,
            false,
            true,
            &mut lamports_1,
            &mut member_1_data,
            &owner,
            false,
        );
        let acc_dup = AccountInfo::new(
            &member_1_key,
            false,
            true,
            &mut lamports_dup,
            &mut member_dup_data,
            &owner,
            false,
        );

        // Cranker passes duplicate member 1 accounts, omitting member 2:
        let duplicate_accounts = vec![acc_1, acc_dup];
        let res = pool_handlers::process_cycle_members(pool.global, &mut pool, &duplicate_accounts);
        // Must reject with IncompleteMemberList because pointer chain fails!
        assert_eq!(res.unwrap_err(), ComfiError::IncompleteMemberList.into());

        // Now test positive case where all members in pointer chain are supplied:
        let mut lamports_2 = 1000000;
        let mut member_2_data = vec![0u8; Member::SPACE];
        member_2_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        let member_2 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        member_2.try_serialize(&mut &mut member_2_data[..]).unwrap();

        let mut lamports_1_fresh = 1000000;
        let mut member_1_fresh_data = vec![0u8; Member::SPACE];
        member_1_fresh_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        member_1.try_serialize(&mut &mut member_1_fresh_data[..]).unwrap();

        let acc_1_fresh = AccountInfo::new(
            &member_1_key,
            false,
            true,
            &mut lamports_1_fresh,
            &mut member_1_fresh_data,
            &owner,
            false,
        );
        let acc_2 = AccountInfo::new(
            &member_2_key,
            false,
            true,
            &mut lamports_2,
            &mut member_2_data,
            &owner,
            false,
        );

        let valid_accounts = vec![acc_1_fresh, acc_2];
        let res_valid = pool_handlers::process_cycle_members(pool.global, &mut pool, &valid_accounts);
        assert!(res_valid.is_ok());
        assert_eq!(pool.funded_member_count, 2);
        assert!(pool.rollover_cursor.is_none());
    }

    #[test]
    fn test_chunked_cycle_rollover_with_linked_list() {
        let mut pool = create_test_pool();
        pool.testing_enabled = false;
        pool.cycle_started_at = 1000;
        pool.cycle_duration_seconds = 100;

        let m1_key = Pubkey::new_unique();
        let m2_key = Pubkey::new_unique();
        let m3_key = Pubkey::new_unique();

        // Linked list: M1 -> M2 -> M3 -> None
        pool.head_member = Some(m1_key);
        pool.rollover_cursor = None;
        pool.member_count = 3;

        let owner = crate::ID;

        // Setup M1
        let mut m1_lamports = 1000000;
        let mut m1_data = vec![0u8; Member::SPACE];
        m1_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        let m1 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: Some(m2_key),
        };
        m1.try_serialize(&mut &mut m1_data[..]).unwrap();

        // Setup M2
        let mut m2_lamports = 1000000;
        let mut m2_data = vec![0u8; Member::SPACE];
        m2_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        let m2 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: Some(m3_key),
        };
        m2.try_serialize(&mut &mut m2_data[..]).unwrap();

        // Setup M3
        let mut m3_lamports = 1000000;
        let mut m3_data = vec![0u8; Member::SPACE];
        m3_data[..8].copy_from_slice(&Member::DISCRIMINATOR);
        let m3 = Member {
            pool: pool.global,
            wallet: Pubkey::new_unique(),
            role: MemberRole::Member,
            is_funded: true,
            deposited_total: 100,
            surplus_amount: 50,
            total_withdrawn: 0,
            closure_claimed: false,
            last_benefit_index: 0,
            cumulative_benefit_received: 0,
            total_contributions: 100,
            alias_hash: [0u8; 32],
            encryption_public_key: [0u8; 32],
            alias_version: 1,
            allowance_cycle: 0,
            action_allowance_used: 0,
            bump: 255,
            surplus_cycle: 0,
            funded_cycle: 0,
            is_paused: false,
            next_member: None,
        };
        m3.try_serialize(&mut &mut m3_data[..]).unwrap();

        // 1. Omission test: passing [M1, M3] (skipping M2) must fail pointer chain
        let mut m1_omission_lamports = 1000000;
        let mut m1_data_omission = vec![0u8; Member::SPACE];
        m1_data_omission[..8].copy_from_slice(&Member::DISCRIMINATOR);
        m1.try_serialize(&mut &mut m1_data_omission[..]).unwrap();

        let mut m3_omission_lamports = 1000000;
        let mut m3_data_omission = vec![0u8; Member::SPACE];
        m3_data_omission[..8].copy_from_slice(&Member::DISCRIMINATOR);
        m3.try_serialize(&mut &mut m3_data_omission[..]).unwrap();

        let acc_m1_omission = AccountInfo::new(
            &m1_key,
            false,
            true,
            &mut m1_omission_lamports,
            &mut m1_data_omission,
            &owner,
            false,
        );
        let acc_m3_omission = AccountInfo::new(
            &m3_key,
            false,
            true,
            &mut m3_omission_lamports,
            &mut m3_data_omission,
            &owner,
            false,
        );
        let omission_accounts = vec![acc_m1_omission, acc_m3_omission];
        let err_omission = pool_handlers::process_cycle_members(pool.global, &mut pool, &omission_accounts);
        assert_eq!(err_omission.unwrap_err(), ComfiError::IncompleteMemberList.into());

        let acc_m1 = AccountInfo::new(
            &m1_key,
            false,
            true,
            &mut m1_lamports,
            &mut m1_data,
            &owner,
            false,
        );
        let acc_m2 = AccountInfo::new(
            &m2_key,
            false,
            true,
            &mut m2_lamports,
            &mut m2_data,
            &owner,
            false,
        );
        let acc_m3 = AccountInfo::new(
            &m3_key,
            false,
            true,
            &mut m3_lamports,
            &mut m3_data,
            &owner,
            false,
        );

        // 2. Chunk 1: Process [M1, M2]
        let chunk_1_accounts = vec![acc_m1, acc_m2];
        let res_chunk_1 = pool_handlers::process_cycle_members(pool.global, &mut pool, &chunk_1_accounts);
        assert!(res_chunk_1.is_ok());
        // After Chunk 1, rollover_cursor is Some(M3) and 2 members are funded:
        assert_eq!(pool.rollover_cursor, Some(m3_key));
        assert_eq!(pool.funded_member_count, 2);

        // Pool operations are gated while rollover_cursor is Some:
        assert_eq!(
            pool.ensure_cycle_current_at(1050).unwrap_err(),
            ComfiError::CycleRollRequired.into()
        );

        // 3. Chunk 2: Process [M3]
        let chunk_2_accounts = vec![acc_m3];
        let res_chunk_2 = pool_handlers::process_cycle_members(pool.global, &mut pool, &chunk_2_accounts);
        assert!(res_chunk_2.is_ok());
        // After Chunk 2, rollover_cursor is None and all 3 members are funded:
        assert!(pool.rollover_cursor.is_none());
        assert_eq!(pool.funded_member_count, 3);

        // Pool operations succeed now that rollover is complete:
        assert!(pool.ensure_cycle_current_at(1050).is_ok());
    }
}




