use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use crate::pool::{transfer_user_tokens, AdmissionMode, ExecutionMode, Member, MemberRole, MemberStatus, Pool};
use crate::ComfiError;

#[account]
pub struct GlobalConfig {
    pub administrator: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury_usdc: Pubkey,
    pub quote_authority: Pubkey,
    pub paused_new_pools: bool,
    pub next_pool_id: u64,
    pub bump: u8,
}

impl GlobalConfig {
    pub const SPACE: usize = 8 + 32 * 4 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolArgs {
    pub member_cap: u32,
    pub minimum_deposit: u64,
    pub member_obligation_amount: u64,
    pub initial_deposit: u64,
    pub enrollment_fee: u64,
    pub vote_threshold: u32,
    pub voting_period_seconds: i64,
    pub timelock_seconds: i64,
    pub cycle_duration_seconds: i64,
    pub action_allowance_per_cycle: u64,
    pub max_sponsored_action_charge: u64,
    pub creator_alias_hash: [u8; 32],
    pub creator_encryption_public_key: [u8; 32],
    pub testing_enabled: bool,
    pub spender_limit_deadline_cycles: u64,
    pub withdrawal_deadline_cycles: u64,
    pub config_modification_deadline_cycles: u64,
    pub spender_limit_execution_mode: ExecutionMode,
    pub withdrawal_execution_mode: ExecutionMode,
    pub config_modification_execution_mode: ExecutionMode,
}

pub fn validate_create_pool(paused_new_pools: bool, args: &CreatePoolArgs) -> Result<()> {
    require!(!paused_new_pools, ComfiError::NewPoolsPaused);
    require!(args.member_cap > 0, ComfiError::InvalidMemberCap);
    require!(
        args.initial_deposit >= args.minimum_deposit,
        ComfiError::DepositBelowMinimum
    );
    require!(
        args.vote_threshold >= 5001 && args.vote_threshold <= 10_000,
        ComfiError::InvalidVoteThreshold
    );
    require!(
        args.cycle_duration_seconds > 0,
        ComfiError::InvalidCycleDuration
    );
    require!(
        args.spender_limit_deadline_cycles > 0,
        ComfiError::InvalidProposalDeadline
    );
    require!(
        args.withdrawal_deadline_cycles > 0,
        ComfiError::InvalidProposalDeadline
    );
    require!(
        args.config_modification_deadline_cycles > 0,
        ComfiError::InvalidProposalDeadline
    );
    #[cfg(not(any(test, feature = "testing")))]
    require!(!args.testing_enabled, ComfiError::TestingNotEnabled);
    if args.initial_deposit >= args.member_obligation_amount {
        let excess = args.initial_deposit
            .checked_sub(args.member_obligation_amount)
            .ok_or(ComfiError::MathOverflow)?;
        require!(
            excess <= args.member_obligation_amount,
            ComfiError::OverfundingCapExceeded
        );
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(mut)]
    pub administrator: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = treasury_usdc.mint == usdc_mint.key() @ ComfiError::WrongMint)]
    pub treasury_usdc: Account<'info, TokenAccount>,
    #[account(init, payer = administrator, space = GlobalConfig::SPACE, seeds = [b"global"], bump)]
    pub global: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    #[account(mut, seeds = [b"global"], bump = global.bump, has_one = administrator)]
    pub global: Account<'info, GlobalConfig>,
    pub administrator: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreatePoolArgs)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, GlobalConfig>>,
    #[account(
        mut,
        constraint = creator_usdc.owner == creator.key() @ ComfiError::Unauthorized,
        constraint = creator_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub creator_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        address = global.treasury_usdc @ ComfiError::InvalidTreasury,
        constraint = treasury_usdc.mint == global.usdc_mint @ ComfiError::WrongMint
    )]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        space = Pool::SPACE,
        seeds = [b"pool".as_ref(), &global.next_pool_id.to_le_bytes()],
        bump
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = global.usdc_mint @ ComfiError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        space = Member::SPACE,
        seeds = [b"member", pool.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_member: Box<Account<'info, Member>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub mod deployer_handlers {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        quote_authority: Pubkey,
    ) -> Result<()> {
        let global = &mut ctx.accounts.global;
        global.administrator = ctx.accounts.administrator.key();
        global.usdc_mint = ctx.accounts.usdc_mint.key();
        global.treasury_usdc = ctx.accounts.treasury_usdc.key();
        global.quote_authority = quote_authority;
        global.paused_new_pools = false;
        global.next_pool_id = 0;
        global.bump = ctx.bumps.global;
        Ok(())
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        new_treasury_usdc: Pubkey,
        new_quote_authority: Pubkey,
    ) -> Result<()> {
        let global = &mut ctx.accounts.global;
        global.treasury_usdc = new_treasury_usdc;
        global.quote_authority = new_quote_authority;
        Ok(())
    }

    pub fn pause_new_pool_creation(ctx: Context<UpdateGlobalConfig>, paused: bool) -> Result<()> {
        ctx.accounts.global.paused_new_pools = paused;
        Ok(())
    }

    pub fn create_pool(ctx: Context<CreatePool>, args: CreatePoolArgs) -> Result<()> {
        validate_create_pool(ctx.accounts.global.paused_new_pools, &args)?;

        let (is_funded, surplus, initial_conferred, initial_non_conferred) =
            if args.initial_deposit >= args.member_obligation_amount {
                let excess = args.initial_deposit
                    .checked_sub(args.member_obligation_amount)
                    .ok_or(ComfiError::MathOverflow)?;
                (true, excess, args.member_obligation_amount, excess)
            } else {
                (false, 0, 0, args.initial_deposit)
            };

        transfer_user_tokens(
            &ctx.accounts.token_program,
            &ctx.accounts.creator_usdc,
            &ctx.accounts.treasury_usdc,
            &ctx.accounts.creator,
            args.enrollment_fee,
        )?;
        transfer_user_tokens(
            &ctx.accounts.token_program,
            &ctx.accounts.creator_usdc,
            &ctx.accounts.vault,
            &ctx.accounts.creator,
            args.initial_deposit,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.global = ctx.accounts.global.key();
        pool.id = ctx.accounts.global.next_pool_id;
        pool.creator = ctx.accounts.creator.key();
        pool.vault = ctx.accounts.vault.key();
        pool.member_cap = args.member_cap;
        pool.member_count = 1;
        pool.minimum_deposit = args.minimum_deposit;
        pool.member_obligation_amount = args.member_obligation_amount;
        pool.vote_threshold = args.vote_threshold;
        pool.voting_period_seconds = args.voting_period_seconds;
        pool.timelock_seconds = args.timelock_seconds;
        pool.current_cycle = 0;
        pool.cycle_duration_seconds = args.cycle_duration_seconds;
        pool.cycle_started_at = Clock::get()?.unix_timestamp;
        pool.action_allowance_per_cycle = args.action_allowance_per_cycle;
        pool.max_sponsored_action_charge = args.max_sponsored_action_charge;
        pool.next_request_id = 0;
        pool.next_proposal_id = 0;
        pool.bump = ctx.bumps.pool;
        #[cfg(any(test, feature = "testing"))]
        {
            pool.testing_enabled = args.testing_enabled;
        }
        #[cfg(not(any(test, feature = "testing")))]
        {
            pool.testing_enabled = false;
        }
        pool.has_pending_config = false;
        pool.pending_vote_threshold = args.vote_threshold;
        pool.pending_cycle_duration_seconds = args.cycle_duration_seconds;
        pool.pending_member_obligation_amount = args.member_obligation_amount;
        pool.spender_limit_deadline_cycles = args.spender_limit_deadline_cycles;
        pool.withdrawal_deadline_cycles = args.withdrawal_deadline_cycles;
        pool.config_modification_deadline_cycles = args.config_modification_deadline_cycles;
        pool.pending_spender_limit_deadline_cycles = args.spender_limit_deadline_cycles;
        pool.pending_withdrawal_deadline_cycles = args.withdrawal_deadline_cycles;
        pool.pending_config_modification_deadline_cycles = args.config_modification_deadline_cycles;
        pool.spender_limit_execution_mode = args.spender_limit_execution_mode;
        pool.withdrawal_execution_mode = args.withdrawal_execution_mode;
        pool.config_modification_execution_mode = args.config_modification_execution_mode;
        pool.pending_spender_limit_execution_mode = args.spender_limit_execution_mode;
        pool.pending_withdrawal_execution_mode = args.withdrawal_execution_mode;
        pool.pending_config_modification_execution_mode = args.config_modification_execution_mode;
        pool.is_closing = false;
        pool.total_non_conferred_capital = initial_non_conferred;
        pool.close_deadline_cycles = args.withdrawal_deadline_cycles;
        pool.close_execution_mode = ExecutionMode::OnDeadline;
        pool.total_escrowed_surplus = 0;
        pool.eviction_deadline_cycles = args.withdrawal_deadline_cycles;
        pool.eviction_execution_mode = ExecutionMode::OnDeadline;
        pool.pending_eviction_deadline_cycles = args.withdrawal_deadline_cycles;
        pool.pending_eviction_execution_mode = ExecutionMode::OnDeadline;
        pool.total_settled_capital = 0;
        pool.funded_member_count = if is_funded { 1 } else { 0 };
        pool.cumulative_benefit_per_member = 0;
        pool.total_conferred_capital = initial_conferred;
        pool.has_snapshotted_closure = false;
        pool.closing_vault_basis = 0;
        pool.closing_non_conferred_basis = 0;
        pool.closing_conferred_pool_capital = 0;
        pool.head_member = Some(ctx.accounts.creator_member.key());
        pool.rollover_cursor = None;
        pool.is_locked = false;
        pool.min_quorum_members = 1;
        pool.min_quorum_bps = 5001;
        pool.locked_consecutive_cycles = 0;
        pool.auto_close_cycles_threshold = 0;
        pool.pending_min_quorum_members = 1;
        pool.pending_min_quorum_bps = 5001;
        pool.pending_auto_close_cycles_threshold = 0;
        pool.admission_mode = AdmissionMode::InviteVouched;
        pool.voting_maturation_cycles = 2;
        pool.proposal_execution_delay_cycles = 1;
        pool.voting_member_count = if is_funded { 1 } else { 0 };
        pool.pending_admission_mode = None;
        pool.pending_voting_maturation_cycles = None;
        pool.pending_proposal_execution_delay_cycles = None;
        ctx.accounts.global.next_pool_id = ctx
            .accounts
            .global
            .next_pool_id
            .checked_add(1)
            .ok_or(ComfiError::MathOverflow)?;

        let member = &mut ctx.accounts.creator_member;
        member.pool = pool.key();
        member.wallet = ctx.accounts.creator.key();
        member.role = MemberRole::Admin;
        member.is_funded = is_funded;
        member.deposited_total = args.initial_deposit;
        member.surplus_amount = surplus;
        member.total_withdrawn = 0;
        member.closure_claimed = false;
        member.last_benefit_index = 0;
        member.cumulative_benefit_received = 0;
        member.total_contributions = args.initial_deposit;
        member.alias_hash = args.creator_alias_hash;
        member.encryption_public_key = args.creator_encryption_public_key;
        member.alias_version = 1;
        member.allowance_cycle = 0;
        member.action_allowance_used = 0;
        member.bump = ctx.bumps.creator_member;
        member.surplus_cycle = 0;
        member.funded_cycle = if is_funded { 0 } else { 0 };
        member.is_paused = false;
        member.next_member = None;
        member.status = MemberStatus::Active;
        member.claimable_surplus_escrow = 0;
        member.vouched_by = None;
        member.lineage_depth = 0;
        member.vouched_count = 0;
        member.joined_cycle = 0;
        member.funded_cycle_streak = if is_funded { 2 } else { 0 };
        member.is_matured_voter = is_funded;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_args() -> CreatePoolArgs {
        CreatePoolArgs {
            member_cap: 10,
            minimum_deposit: 100,
            member_obligation_amount: 50,
            initial_deposit: 100,
            enrollment_fee: 10,
            vote_threshold: 5001,
            voting_period_seconds: 604800,
            timelock_seconds: 86400,
            cycle_duration_seconds: 2592000,
            action_allowance_per_cycle: 1000,
            max_sponsored_action_charge: 50,
            creator_alias_hash: [0u8; 32],
            creator_encryption_public_key: [0u8; 32],
            testing_enabled: false,
            spender_limit_deadline_cycles: 1,
            withdrawal_deadline_cycles: 1,
            config_modification_deadline_cycles: 2,
            spender_limit_execution_mode: ExecutionMode::OnDeadline,
            withdrawal_execution_mode: ExecutionMode::OnDeadline,
            config_modification_execution_mode: ExecutionMode::OnDeadline,
        }
    }

    #[test]
    fn test_global_config_space_constant() {
        // 8 discriminator + 4 * 32 (admin, usdc_mint, treasury, quote_auth) + 1 (paused) + 8 (next_pool_id) + 1 (bump)
        assert_eq!(GlobalConfig::SPACE, 8 + 32 * 4 + 1 + 8 + 1);
        assert_eq!(GlobalConfig::SPACE, 146);
    }

    #[test]
    fn test_validate_create_pool_success() {
        let args = valid_args();
        assert!(validate_create_pool(false, &args).is_ok());
    }

    #[test]
    fn test_validate_create_pool_paused() {
        let args = valid_args();
        let err = validate_create_pool(true, &args).unwrap_err();
        assert_eq!(err, ComfiError::NewPoolsPaused.into());
    }

    #[test]
    fn test_validate_create_pool_zero_member_cap() {
        let mut args = valid_args();
        args.member_cap = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidMemberCap.into());
    }

    #[test]
    fn test_validate_create_pool_deposit_below_minimum() {
        let mut args = valid_args();
        args.minimum_deposit = 200;
        args.initial_deposit = 100;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::DepositBelowMinimum.into());
    }

    #[test]
    fn test_validate_create_pool_overfunding_cap_exceeded() {
        let mut args = valid_args();
        // obligation is 50, maximum surplus is 50, so max allowed initial_deposit is 100
        args.initial_deposit = 101;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::OverfundingCapExceeded.into());
    }

    #[test]
    fn test_validate_create_pool_invalid_vote_threshold_zero() {
        let mut args = valid_args();
        args.vote_threshold = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidVoteThreshold.into());
    }

    #[test]
    fn test_validate_create_pool_invalid_vote_threshold_below_min() {
        let mut args = valid_args();
        args.vote_threshold = 5000; // Below strict majority minimum floor (5001 bps)
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidVoteThreshold.into());

        args.vote_threshold = 99;
        let err2 = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err2, ComfiError::InvalidVoteThreshold.into());
    }

    #[test]
    fn test_validate_create_pool_invalid_vote_threshold_exceeds_cap() {
        let mut args = valid_args();
        args.vote_threshold = 10_001;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidVoteThreshold.into());
    }

    #[test]
    fn test_validate_create_pool_zero_cycle_duration() {
        let mut args = valid_args();
        args.cycle_duration_seconds = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidCycleDuration.into());
    }

    #[test]
    fn test_validate_create_pool_zero_spender_limit_deadline_cycles() {
        let mut args = valid_args();
        args.spender_limit_deadline_cycles = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidProposalDeadline.into());
    }

    #[test]
    fn test_validate_create_pool_zero_withdrawal_deadline_cycles() {
        let mut args = valid_args();
        args.withdrawal_deadline_cycles = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidProposalDeadline.into());
    }

    #[test]
    fn test_validate_create_pool_zero_config_modification_deadline_cycles() {
        let mut args = valid_args();
        args.config_modification_deadline_cycles = 0;
        let err = validate_create_pool(false, &args).unwrap_err();
        assert_eq!(err, ComfiError::InvalidProposalDeadline.into());
    }

    #[test]
    fn test_global_config_state_mutation() {
        let mut config = GlobalConfig {
            administrator: Pubkey::new_unique(),
            usdc_mint: Pubkey::new_unique(),
            treasury_usdc: Pubkey::new_unique(),
            quote_authority: Pubkey::new_unique(),
            paused_new_pools: false,
            next_pool_id: 0,
            bump: 254,
        };

        // Update treasury and quote authority
        let new_treasury = Pubkey::new_unique();
        let new_quote_auth = Pubkey::new_unique();
        config.treasury_usdc = new_treasury;
        config.quote_authority = new_quote_auth;
        assert_eq!(config.treasury_usdc, new_treasury);
        assert_eq!(config.quote_authority, new_quote_auth);

        // Toggle pause
        config.paused_new_pools = true;
        assert!(config.paused_new_pools);
        config.paused_new_pools = false;
        assert!(!config.paused_new_pools);

        // Next pool id increment
        config.next_pool_id = config.next_pool_id.checked_add(1).unwrap();
        assert_eq!(config.next_pool_id, 1);
    }
}
