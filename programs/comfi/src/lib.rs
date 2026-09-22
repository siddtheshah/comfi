use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

// Devnet/localnet program ID derived from target/deploy/comfi-keypair.json.
declare_id!("bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY");

#[program]
pub mod comfi {
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
        require!(!ctx.accounts.global.paused_new_pools, ComfiError::NewPoolsPaused);
        require!(args.member_cap > 0, ComfiError::InvalidMemberCap);
        require!(args.initial_deposit >= args.minimum_deposit, ComfiError::DepositBelowMinimum);
        require!(args.vote_threshold > 0 && args.vote_threshold <= args.member_cap, ComfiError::InvalidVoteThreshold);
        require!(args.cycle_duration_seconds > 0, ComfiError::InvalidCycleDuration);

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
        ctx.accounts.global.next_pool_id = ctx.accounts.global.next_pool_id.checked_add(1).ok_or(ComfiError::MathOverflow)?;

        let member = &mut ctx.accounts.creator_member;
        member.pool = pool.key();
        member.wallet = ctx.accounts.creator.key();
        member.role = MemberRole::Admin;
        member.is_funded = true;
        member.deposited_total = args.initial_deposit;
        member.alias_hash = args.creator_alias_hash;
        member.encryption_public_key = args.creator_encryption_public_key;
        member.alias_version = 1;
        member.allowance_cycle = 0;
        member.action_allowance_used = 0;
        member.bump = ctx.bumps.creator_member;
        Ok(())
    }

    pub fn join_pool(ctx: Context<JoinPool>, args: JoinPoolArgs) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.member_count < pool.member_cap, ComfiError::MemberCapReached);
        require!(args.initial_deposit >= pool.minimum_deposit, ComfiError::DepositBelowMinimum);
        transfer_user_tokens(&ctx.accounts.token_program, &ctx.accounts.user_usdc, &ctx.accounts.vault, &ctx.accounts.user, args.initial_deposit)?;
        pool.member_count = pool.member_count.checked_add(1).ok_or(ComfiError::MathOverflow)?;

        let member = &mut ctx.accounts.member;
        member.pool = pool.key();
        member.wallet = ctx.accounts.user.key();
        member.role = MemberRole::Member;
        member.is_funded = true;
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
        transfer_user_tokens(&ctx.accounts.token_program, &ctx.accounts.source_usdc, &ctx.accounts.vault, &ctx.accounts.member_wallet, amount)?;
        let member = &mut ctx.accounts.member;
        member.deposited_total = member.deposited_total.checked_add(amount).ok_or(ComfiError::MathOverflow)?;
        member.is_funded = true;
        Ok(())
    }

    pub fn set_alias(ctx: Context<MemberOnly>, alias_hash: [u8; 32], encryption_public_key: [u8; 32]) -> Result<()> {
        let member = &mut ctx.accounts.member;
        member.alias_hash = alias_hash;
        member.encryption_public_key = encryption_public_key;
        member.alias_version = member.alias_version.checked_add(1).ok_or(ComfiError::MathOverflow)?;
        Ok(())
    }

    /// Executes the allowlisted alias-update action and atomically pays its
    /// bounded sponsor charge. The transaction immediately before this call
    /// must be an Ed25519 verification of the exact serialized quote.
    pub fn run_sponsored_set_alias(
        ctx: Context<RunSponsoredSetAlias>,
        quote: SponsorQuote,
        alias_hash: [u8; 32],
        encryption_public_key: [u8; 32],
    ) -> Result<()> {
        require!(quote.action == SponsoredAction::SetAlias, ComfiError::WrongSponsoredAction);
        require_keys_eq!(quote.pool, ctx.accounts.pool.key(), ComfiError::QuotePoolMismatch);
        require_keys_eq!(quote.member, ctx.accounts.member.key(), ComfiError::QuoteMemberMismatch);
        require_keys_eq!(quote.treasury_usdc, ctx.accounts.treasury_usdc.key(), ComfiError::InvalidTreasury);
        require!(quote.expires_at >= Clock::get()?.unix_timestamp, ComfiError::QuoteExpired);
        require!(quote.charge_usdc <= ctx.accounts.pool.max_sponsored_action_charge, ComfiError::SponsorChargeTooHigh);
        verify_preceding_ed25519_quote(&ctx.accounts.instructions, &ctx.accounts.global.quote_authority, &quote)?;
        let member = &mut ctx.accounts.member;
        if member.allowance_cycle != ctx.accounts.pool.current_cycle {
            member.allowance_cycle = ctx.accounts.pool.current_cycle;
            member.action_allowance_used = 0;
        }
        let next_used = member.action_allowance_used.checked_add(quote.charge_usdc).ok_or(ComfiError::MathOverflow)?;
        require!(next_used <= ctx.accounts.pool.action_allowance_per_cycle, ComfiError::ActionAllowanceExceeded);

        let signer_seeds: &[&[u8]] = &[b"pool", &ctx.accounts.pool.id.to_le_bytes(), &[ctx.accounts.pool.bump]];
        token::transfer(CpiContext::new_with_signer(
            Token::id(),
            Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.treasury_usdc.to_account_info(), authority: ctx.accounts.pool.to_account_info() },
            &[signer_seeds],
        ), quote.charge_usdc)?;
        member.action_allowance_used = next_used;
        member.alias_hash = alias_hash;
        member.encryption_public_key = encryption_public_key;
        member.alias_version = member.alias_version.checked_add(1).ok_or(ComfiError::MathOverflow)?;
        let receipt = &mut ctx.accounts.quote_receipt;
        receipt.pool = ctx.accounts.pool.key();
        receipt.member = member.key();
        receipt.quote_id = quote.quote_id;
        receipt.bump = ctx.bumps.quote_receipt;
        Ok(())
    }

    pub fn roll_cycle(ctx: Context<RollCycle>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let next_start = pool.cycle_started_at.checked_add(pool.cycle_duration_seconds).ok_or(ComfiError::MathOverflow)?;
        require!(Clock::get()?.unix_timestamp >= next_start, ComfiError::CycleNotReady);
        pool.current_cycle = pool.current_cycle.checked_add(1).ok_or(ComfiError::MathOverflow)?;
        pool.cycle_started_at = next_start;
        Ok(())
    }

    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, args: WithdrawalArgs) -> Result<()> {
        require!(args.amount > 0, ComfiError::InvalidAmount);
        require!(ctx.accounts.member.can_request_spend(), ComfiError::NotSpender);
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
        ctx.accounts.pool.next_request_id = ctx.accounts.pool.next_request_id.checked_add(1).ok_or(ComfiError::MathOverflow)?;
        Ok(())
    }

    pub fn create_proposal(ctx: Context<CreateProposal>, action: ProposalAction) -> Result<()> {
        require!(ctx.accounts.proposer.is_funded, ComfiError::MemberNotFunded);
        let clock = Clock::get()?;
        let proposal = &mut ctx.accounts.proposal;
        proposal.pool = ctx.accounts.pool.key();
        proposal.id = ctx.accounts.pool.next_proposal_id;
        proposal.proposer = ctx.accounts.proposer.key();
        proposal.action = action;
        proposal.yes_votes = 0;
        proposal.no_votes = 0;
        proposal.deadline = clock.unix_timestamp.checked_add(ctx.accounts.pool.voting_period_seconds).ok_or(ComfiError::MathOverflow)?;
        proposal.executable_after = 0;
        proposal.state = ProposalState::Open;
        proposal.bump = ctx.bumps.proposal;
        ctx.accounts.pool.next_proposal_id = ctx.accounts.pool.next_proposal_id.checked_add(1).ok_or(ComfiError::MathOverflow)?;
        Ok(())
    }

    pub fn vote(ctx: Context<Vote>, approve: bool) -> Result<()> {
        let clock = Clock::get()?;
        let proposal = &mut ctx.accounts.proposal;
        require!(ctx.accounts.voter.is_funded, ComfiError::MemberNotFunded);
        require!(proposal.state == ProposalState::Open, ComfiError::ProposalNotOpen);
        require!(clock.unix_timestamp <= proposal.deadline, ComfiError::VotingClosed);
        if approve { proposal.yes_votes = proposal.yes_votes.checked_add(1).ok_or(ComfiError::MathOverflow)?; }
        else { proposal.no_votes = proposal.no_votes.checked_add(1).ok_or(ComfiError::MathOverflow)?; }
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
        require!(proposal.state == ProposalState::Open, ComfiError::ProposalNotOpen);
        require!(clock.unix_timestamp > proposal.deadline, ComfiError::VotingStillOpen);
        if proposal.yes_votes >= ctx.accounts.pool.vote_threshold && proposal.yes_votes > proposal.no_votes {
            proposal.state = ProposalState::Executable;
            proposal.executable_after = clock.unix_timestamp.checked_add(ctx.accounts.pool.timelock_seconds).ok_or(ComfiError::MathOverflow)?;
        } else { proposal.state = ProposalState::Rejected; }
        Ok(())
    }

    pub fn execute_spender_limit(ctx: Context<ExecuteSpenderLimit>) -> Result<()> {
        assert_executable(&ctx.accounts.proposal)?;
        let (target, cap) = match ctx.accounts.proposal.action {
            ProposalAction::SetSpenderLimit { member, cap } => (member, cap),
            _ => return err!(ComfiError::WrongProposalAction),
        };
        require_keys_eq!(target, ctx.accounts.spender_member.key(), ComfiError::ProposalTargetMismatch);
        require!(ctx.accounts.spender_member.can_request_spend(), ComfiError::NotSpender);
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

    pub fn spend(ctx: Context<Spend>) -> Result<()> {
        let request = &mut ctx.accounts.request;
        require!(request.status == WithdrawalStatus::Pending, ComfiError::RequestNotPending);
        require!(ctx.accounts.executor_member.is_funded, ComfiError::MemberNotFunded);
        require!(ctx.accounts.requester_member.can_request_spend(), ComfiError::NotSpender);
        require!(ctx.accounts.spender_cycle.cycle == ctx.accounts.pool.current_cycle, ComfiError::WrongCycle);
        require!(ctx.accounts.spender_cycle.member == ctx.accounts.requester_member.key(), ComfiError::InvalidSpendCycle);
        if request.requires_proposal {
            let proposal = ctx.accounts.proposal.as_ref().ok_or(ComfiError::ProposalRequired)?;
            assert_executable(proposal)?;
            match proposal.action { ProposalAction::ApproveWithdrawal { request: key } if key == request.key() => {}, _ => return err!(ComfiError::WrongProposalAction) }
            ctx.accounts.proposal.as_mut().unwrap().state = ProposalState::Executed;
        }
        let cycle = &mut ctx.accounts.spender_cycle;
        let next_spent = cycle.spent.checked_add(request.amount).ok_or(ComfiError::MathOverflow)?;
        require!(next_spent <= cycle.cap, ComfiError::SpendLimitExceeded);
        let signer_seeds: &[&[u8]] = &[b"pool", &ctx.accounts.pool.id.to_le_bytes(), &[ctx.accounts.pool.bump]];
        let signer = &[signer_seeds];
        let cpi = CpiContext::new_with_signer(
            Token::id(),
            Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.recipient_usdc.to_account_info(), authority: ctx.accounts.pool.to_account_info() },
            signer,
        );
        token::transfer(cpi, request.amount)?;
        cycle.spent = next_spent;
        request.status = WithdrawalStatus::Spent;
        Ok(())
    }
}

fn transfer_user_tokens<'info>(_token_program: &Program<'info, Token>, from: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>, authority: &Signer<'info>, amount: u64) -> Result<()> {
    token::transfer(CpiContext::new(Token::id(), Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: authority.to_account_info() }), amount)
}

fn assert_executable(proposal: &Account<Proposal>) -> Result<()> {
    require!(proposal.state == ProposalState::Executable, ComfiError::ProposalNotExecutable);
    require!(Clock::get()?.unix_timestamp >= proposal.executable_after, ComfiError::TimelockActive);
    Ok(())
}

/// Verifies that the immediately preceding Ed25519 instruction verified the
/// serialized quote with GlobalConfig.quote_authority. Keeping the signature in
/// the Ed25519 program instruction avoids trusting a user-supplied byte field.
fn verify_preceding_ed25519_quote(instructions: &UncheckedAccount, signer: &Pubkey, quote: &SponsorQuote) -> Result<()> {
    use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
    use solana_sdk_ids::ed25519_program;
    let current = load_current_index_checked(&instructions.to_account_info())?;
    require!(current > 0, ComfiError::MissingQuoteVerification);
    let ix = load_instruction_at_checked((current - 1) as usize, &instructions.to_account_info())?;
    require_keys_eq!(ix.program_id, ed25519_program::id(), ComfiError::MissingQuoteVerification);
    // Ed25519 instruction format for one signature. All offsets must refer to
    // this instruction (u16::MAX), which keeps message bytes unambiguous.
    require!(ix.data.len() >= 16 && ix.data[0] == 1, ComfiError::InvalidQuoteSignature);
    let offset = |start: usize| -> Result<u16> { ix.data.get(start..start + 2).and_then(|v| v.try_into().ok()).map(u16::from_le_bytes).ok_or(error!(ComfiError::InvalidQuoteSignature)) };
    let signature_offset = offset(2)?; let sig_ix = offset(4)?; let key_offset = offset(6)?; let key_ix = offset(8)?;
    let message_offset = offset(10)?; let message_size = offset(12)?; let message_ix = offset(14)?;
    require!(sig_ix == u16::MAX && key_ix == u16::MAX && message_ix == u16::MAX, ComfiError::InvalidQuoteSignature);
    let key_start = key_offset as usize;
    let signature_start = signature_offset as usize;
    let message_start = message_offset as usize;
    let message_end = message_start.checked_add(message_size as usize).ok_or(ComfiError::InvalidQuoteSignature)?;
    require!(ix.data.get(signature_start..signature_start + 64).is_some(), ComfiError::InvalidQuoteSignature);
    require!(ix.data.get(key_start..key_start + 32) == Some(signer.as_ref()), ComfiError::InvalidQuoteSignature);
    let mut serialized_quote = Vec::new();
    quote.serialize(&mut serialized_quote).map_err(|_| error!(ComfiError::InvalidQuoteSignature))?;
    require!(ix.data.get(message_start..message_end) == Some(serialized_quote.as_slice()), ComfiError::InvalidQuoteSignature);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(mut)] pub administrator: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = treasury_usdc.mint == usdc_mint.key() @ ComfiError::WrongMint)] pub treasury_usdc: Account<'info, TokenAccount>,
    #[account(init, payer = administrator, space = GlobalConfig::SPACE, seeds = [b"global"], bump)] pub global: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    #[account(mut, seeds = [b"global"], bump = global.bump, has_one = administrator)] pub global: Account<'info, GlobalConfig>,
    pub administrator: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreatePoolArgs)]
pub struct CreatePool<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(mut, seeds = [b"global"], bump = global.bump)] pub global: Box<Account<'info, GlobalConfig>>,
    #[account(mut, constraint = creator_usdc.owner == creator.key() @ ComfiError::Unauthorized, constraint = creator_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub creator_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = global.treasury_usdc @ ComfiError::InvalidTreasury, constraint = treasury_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, space = Pool::SPACE, seeds = [b"pool".as_ref(), &global.next_pool_id.to_le_bytes()], bump)] pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = creator, associated_token::mint = usdc_mint, associated_token::authority = pool)] pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = global.usdc_mint @ ComfiError::WrongMint)] pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = Member::SPACE, seeds = [b"member", pool.key().as_ref(), creator.key().as_ref()], bump)] pub creator_member: Box<Account<'info, Member>>,
    pub token_program: Program<'info, Token>, pub associated_token_program: Program<'info, AssociatedToken>, pub system_program: Program<'info, System>, pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct JoinPool<'info> {
    #[account(mut)] pub user: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)] pub global: Account<'info, GlobalConfig>,
    #[account(mut, has_one = global, constraint = vault.key() == pool.vault @ ComfiError::InvalidVault)] pub pool: Account<'info, Pool>,
    #[account(mut, constraint = user_usdc.owner == user.key() @ ComfiError::Unauthorized, constraint = user_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault, constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint)] pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = user, space = Member::SPACE, seeds = [b"member", pool.key().as_ref(), user.key().as_ref()], bump)] pub member: Account<'info, Member>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)] pub member_wallet: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)] pub global: Account<'info, GlobalConfig>,
    #[account(has_one = global, constraint = vault.key() == pool.vault @ ComfiError::InvalidVault)] pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()], bump = member.bump, has_one = pool, constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized)] pub member: Account<'info, Member>,
    #[account(mut, constraint = source_usdc.owner == member_wallet.key() @ ComfiError::Unauthorized, constraint = source_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub source_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault)] pub vault: Account<'info, TokenAccount>, pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MemberOnly<'info> {
    pub member_wallet: Signer<'info>,
    #[account(mut, seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()], bump = member.bump, has_one = pool, constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized)] pub member: Account<'info, Member>,
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
#[instruction(quote: SponsorQuote)]
pub struct RunSponsoredSetAlias<'info> {
    #[account(mut)] pub member_wallet: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)] pub global: Box<Account<'info, GlobalConfig>>,
    #[account(has_one = global, constraint = vault.key() == pool.vault @ ComfiError::InvalidVault)] pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()], bump = member.bump, has_one = pool, constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized)] pub member: Box<Account<'info, Member>>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault, constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint)] pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = global.treasury_usdc @ ComfiError::InvalidTreasury, constraint = treasury_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: Anchor's instructions sysvar parser validates this account.
    #[account(address = solana_instructions_sysvar::ID)] pub instructions: UncheckedAccount<'info>,
    #[account(init, payer = member_wallet, space = SponsorQuoteReceipt::SPACE, seeds = [b"quote", pool.key().as_ref(), quote.quote_id.as_ref()], bump)] pub quote_receipt: Box<Account<'info, SponsorQuoteReceipt>>,
    pub token_program: Program<'info, Token>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RollCycle<'info> { #[account(mut)] pub pool: Account<'info, Pool> }

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)] pub member_wallet: Signer<'info>,
    #[account(mut)] pub pool: Account<'info, Pool>,
    #[account(seeds = [b"member", pool.key().as_ref(), member_wallet.key().as_ref()], bump = member.bump, has_one = pool, constraint = member.wallet == member_wallet.key() @ ComfiError::Unauthorized)] pub member: Account<'info, Member>,
    #[account(init, payer = member_wallet, space = WithdrawalRequest::SPACE, seeds = [b"request", pool.key().as_ref(), &pool.next_request_id.to_le_bytes()], bump)] pub request: Account<'info, WithdrawalRequest>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)] pub proposer_wallet: Signer<'info>, #[account(mut)] pub pool: Account<'info, Pool>,
    #[account(seeds = [b"member", pool.key().as_ref(), proposer_wallet.key().as_ref()], bump = proposer.bump, has_one = pool, constraint = proposer.wallet == proposer_wallet.key() @ ComfiError::Unauthorized)] pub proposer: Account<'info, Member>,
    #[account(init, payer = proposer_wallet, space = Proposal::SPACE, seeds = [b"proposal", pool.key().as_ref(), &pool.next_proposal_id.to_le_bytes()], bump)] pub proposal: Account<'info, Proposal>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    #[account(mut)] pub voter_wallet: Signer<'info>, pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)] pub proposal: Account<'info, Proposal>,
    #[account(seeds = [b"member", pool.key().as_ref(), voter_wallet.key().as_ref()], bump = voter.bump, has_one = pool, constraint = voter.wallet == voter_wallet.key() @ ComfiError::Unauthorized)] pub voter: Account<'info, Member>,
    #[account(init, payer = voter_wallet, space = VoteReceipt::SPACE, seeds = [b"vote", proposal.key().as_ref(), voter.key().as_ref()], bump)] pub receipt: Account<'info, VoteReceipt>, pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeProposal<'info> { pub pool: Account<'info, Pool>, #[account(mut, has_one = pool)] pub proposal: Account<'info, Proposal> }

#[derive(Accounts)]
pub struct ExecuteSpenderLimit<'info> {
    #[account(mut)] pub executor: Signer<'info>, #[account(mut)] pub pool: Account<'info, Pool>,
    #[account(mut, has_one = pool)] pub proposal: Account<'info, Proposal>,
    #[account(has_one = pool)] pub spender_member: Account<'info, Member>,
    #[account(init_if_needed, payer = executor, space = SpenderCycle::SPACE, seeds = [b"cycle", pool.key().as_ref(), spender_member.key().as_ref(), &pool.current_cycle.to_le_bytes()], bump)] pub spender_cycle: Account<'info, SpenderCycle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [b"global"], bump = global.bump)] pub global: Box<Account<'info, GlobalConfig>>,
    #[account(mut, has_one = global)] pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool)] pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(seeds = [b"member", pool.key().as_ref(), executor.key().as_ref()], bump = executor_member.bump, has_one = pool, constraint = executor_member.wallet == executor.key() @ ComfiError::Unauthorized)] pub executor_member: Box<Account<'info, Member>>,
    #[account(has_one = pool, constraint = requester_member.key() == request.requester @ ComfiError::Unauthorized)] pub requester_member: Box<Account<'info, Member>>,
    #[account(mut, seeds = [b"cycle", pool.key().as_ref(), requester_member.key().as_ref(), &pool.current_cycle.to_le_bytes()], bump = spender_cycle.bump)] pub spender_cycle: Box<Account<'info, SpenderCycle>>,
    #[account(mut, address = pool.vault @ ComfiError::InvalidVault, constraint = vault.mint == global.usdc_mint @ ComfiError::WrongMint)] pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = recipient_usdc.key() == request.recipient @ ComfiError::RecipientMismatch, constraint = recipient_usdc.mint == global.usdc_mint @ ComfiError::WrongMint)] pub recipient_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>, #[account(mut, has_one = pool)] pub proposal: Option<Box<Account<'info, Proposal>>>,
}

#[account]
pub struct GlobalConfig { pub administrator: Pubkey, pub usdc_mint: Pubkey, pub treasury_usdc: Pubkey, pub quote_authority: Pubkey, pub paused_new_pools: bool, pub next_pool_id: u64, pub bump: u8 }
impl GlobalConfig { pub const SPACE: usize = 8 + 32 * 4 + 1 + 8 + 1; }

/// PDA seeds: ["pool", pool_id.to_le_bytes()]. It is also the vault authority.
#[account]
pub struct Pool { pub global: Pubkey, pub id: u64, pub creator: Pubkey, pub vault: Pubkey, pub member_cap: u32, pub member_count: u32, pub minimum_deposit: u64, pub vote_threshold: u32, pub voting_period_seconds: i64, pub timelock_seconds: i64, pub current_cycle: u64, pub cycle_duration_seconds: i64, pub cycle_started_at: i64, pub action_allowance_per_cycle: u64, pub max_sponsored_action_charge: u64, pub next_request_id: u64, pub next_proposal_id: u64, pub bump: u8 }
impl Pool { pub const SPACE: usize = 8 + 197; }

/// PDA seeds: ["member", pool, wallet]. Alias bytes are never stored on chain.
#[account]
pub struct Member { pub pool: Pubkey, pub wallet: Pubkey, pub role: MemberRole, pub is_funded: bool, pub deposited_total: u64, pub alias_hash: [u8; 32], pub encryption_public_key: [u8; 32], pub alias_version: u32, pub allowance_cycle: u64, pub action_allowance_used: u64, pub bump: u8 }
impl Member { pub const SPACE: usize = 8 + 32 + 32 + 1 + 1 + 8 + 32 + 32 + 4 + 8 + 8 + 1; fn can_request_spend(&self) -> bool { matches!(self.role, MemberRole::Spender | MemberRole::Admin) } }

/// PDA seeds: ["cycle", pool, member, cycle.to_le_bytes()].
#[account]
pub struct SpenderCycle { pub pool: Pubkey, pub member: Pubkey, pub cycle: u64, pub cap: u64, pub spent: u64, pub bump: u8 }
impl SpenderCycle { pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1; }

#[account]
pub struct WithdrawalRequest { pub pool: Pubkey, pub id: u64, pub requester: Pubkey, pub recipient: Pubkey, pub amount: u64, pub justification_hash: [u8; 32], pub requires_proposal: bool, pub status: WithdrawalStatus, pub bump: u8 }
impl WithdrawalRequest { pub const SPACE: usize = 8 + 32 + 8 + 32 + 32 + 8 + 32 + 1 + 1 + 1; }

#[account]
pub struct Proposal { pub pool: Pubkey, pub id: u64, pub proposer: Pubkey, pub action: ProposalAction, pub yes_votes: u32, pub no_votes: u32, pub deadline: i64, pub executable_after: i64, pub state: ProposalState, pub bump: u8 }
impl Proposal { pub const SPACE: usize = 8 + 32 + 8 + 32 + 41 + 4 + 4 + 8 + 8 + 1 + 1; }

#[account]
pub struct VoteReceipt { pub proposal: Pubkey, pub voter: Pubkey, pub approve: bool, pub bump: u8 }
impl VoteReceipt { pub const SPACE: usize = 8 + 32 + 32 + 1 + 1; }

/// PDA seeds: ["quote", pool, quote_id]. Its existence makes a sponsor quote
/// single-use even if a signed client transaction is submitted twice.
#[account]
pub struct SponsorQuoteReceipt { pub pool: Pubkey, pub member: Pubkey, pub quote_id: [u8; 32], pub bump: u8 }
impl SponsorQuoteReceipt { pub const SPACE: usize = 8 + 32 + 32 + 32 + 1; }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)] pub enum MemberRole { Member, Spender, Admin }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)] pub enum WithdrawalStatus { Pending, Spent, Cancelled }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)] pub enum ProposalState { Open, Executable, Executed, Rejected }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)] pub enum ProposalAction { SetSpenderLimit { member: Pubkey, cap: u64 }, ApproveWithdrawal { request: Pubkey } }
/// Exact message signed by the sponsor API. `quote_id` permits off-chain audit
/// and replay monitoring; on-chain expiry and allowance checks are decisive.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)] pub struct SponsorQuote { pub quote_id: [u8; 32], pub pool: Pubkey, pub member: Pubkey, pub action: SponsoredAction, pub charge_usdc: u64, pub expires_at: i64, pub treasury_usdc: Pubkey }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)] pub enum SponsoredAction { SetAlias }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct CreatePoolArgs { pub member_cap: u32, pub minimum_deposit: u64, pub initial_deposit: u64, pub enrollment_fee: u64, pub vote_threshold: u32, pub voting_period_seconds: i64, pub timelock_seconds: i64, pub cycle_duration_seconds: i64, pub action_allowance_per_cycle: u64, pub max_sponsored_action_charge: u64, pub creator_alias_hash: [u8; 32], pub creator_encryption_public_key: [u8; 32] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct JoinPoolArgs { pub initial_deposit: u64, pub alias_hash: [u8; 32], pub encryption_public_key: [u8; 32] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)] pub struct WithdrawalArgs { pub recipient: Pubkey, pub amount: u64, pub justification_hash: [u8; 32], pub requires_proposal: bool }

#[error_code]
pub enum ComfiError {
    #[msg("Only the pool's pinned USDC mint is accepted.")] WrongMint,
    #[msg("The supplied treasury does not match global configuration.")] InvalidTreasury,
    #[msg("New pool creation is paused.")] NewPoolsPaused,
    #[msg("The member cap is invalid.")] InvalidMemberCap,
    #[msg("The voting threshold is invalid.")] InvalidVoteThreshold,
    #[msg("Pool membership is full.")] MemberCapReached,
    #[msg("Deposit is below the pool minimum.")] DepositBelowMinimum,
    #[msg("Amount must be positive.")] InvalidAmount,
    #[msg("Arithmetic overflow.")] MathOverflow,
    #[msg("Caller is not authorized for this action.")] Unauthorized,
    #[msg("Invalid pool vault.")] InvalidVault,
    #[msg("Member is not a funded voting member.")] MemberNotFunded,
    #[msg("Member is not an approved spender.")] NotSpender,
    #[msg("Proposal is not open.")] ProposalNotOpen,
    #[msg("Voting has closed.")] VotingClosed,
    #[msg("Voting deadline has not passed.")] VotingStillOpen,
    #[msg("Proposal is not executable.")] ProposalNotExecutable,
    #[msg("Proposal timelock is still active.")] TimelockActive,
    #[msg("Proposal action does not match this instruction.")] WrongProposalAction,
    #[msg("Proposal target does not match supplied account.")] ProposalTargetMismatch,
    #[msg("Withdrawal request is not pending.")] RequestNotPending,
    #[msg("A passed proposal is required for this request.")] ProposalRequired,
    #[msg("Recipient token account differs from the request.")] RecipientMismatch,
    #[msg("Spend would exceed the approved cycle limit.")] SpendLimitExceeded,
    #[msg("Spend cycle does not match the pool cycle.")] WrongCycle,
    #[msg("Invalid spender cycle.")] InvalidSpendCycle,
    #[msg("Funding cycle duration must be positive.")] InvalidCycleDuration,
    #[msg("The current funding cycle has not ended.")] CycleNotReady,
    #[msg("Sponsor quote action is not permitted by this instruction.")] WrongSponsoredAction,
    #[msg("Sponsor quote is for a different pool.")] QuotePoolMismatch,
    #[msg("Sponsor quote is for a different member.")] QuoteMemberMismatch,
    #[msg("Sponsor quote has expired.")] QuoteExpired,
    #[msg("Sponsor charge exceeds this pool's action limit.")] SponsorChargeTooHigh,
    #[msg("Sponsor charge would exceed the member's cycle allowance.")] ActionAllowanceExceeded,
    #[msg("Missing the required preceding Ed25519 quote verification.")] MissingQuoteVerification,
    #[msg("Sponsor quote signature or signed message is invalid.")] InvalidQuoteSignature,
}
