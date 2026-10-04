use anchor_lang::prelude::*;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sha256_hasher::hash;

declare_id!("7FHwv2r8R8avPiqq7ZaAUx3XYozt36F1zFfoNMHZeJ57");

pub const RP_ID: &str = "localhost";
pub const ORIGIN: &str = "http://localhost:5173";
pub const CLUSTER_DOMAIN: &[u8] = b"comfi:standalone:localnet:v1";
pub const MAX_APPROVAL_SECONDS: i64 = 300;
pub const MAX_WALLETS: u16 = 8;
pub const MAX_PASSKEYS: u16 = 8;
const R1_PROGRAM: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");
const REGISTRATION_SIZE: usize = 164;

#[program]
pub mod user_account {
    use super::*;

    pub fn create_user(ctx: Context<CreateUser>, args: CreateUserArgs) -> Result<()> {
        // A release build has no bootstrap route until production RP/origin,
        // cluster policy, enrollment and verifier budgets are separately reviewed.
        require!(cfg!(feature = "testing"), AccountError::LocalnetOnly);
        let now = Clock::get()?.unix_timestamp;
        require!(
            args.expires_at > now && args.expires_at <= now + MAX_APPROVAL_SECONDS,
            AccountError::InvalidExpiry
        );
        let key = validate_registration(&args.registration_authenticator_data)?;
        let credential = credential_hash(&args.registration_authenticator_data);
        require!(
            args.credential_hash == credential,
            AccountError::InvalidRegistration
        );
        let payload = creation_payload(
            ctx.accounts.user.key(),
            ctx.accounts.wallet.key(),
            ctx.accounts.payer.key(),
            &args.user_id,
            &key,
            &credential,
            args.expires_at,
        );
        // The possession assertion commits to registration bytes AND the exact
        // deterministic webauthn.create client data, including its distinct purpose.
        let registration_client = client_data("webauthn.create", &hash(&payload).to_bytes());
        let mut approval = b"comfi:user-account:possession:v1\0".to_vec();
        approval.extend_from_slice(&payload);
        approval.extend_from_slice(&hash(&args.registration_authenticator_data).to_bytes());
        approval.extend_from_slice(&hash(&registration_client).to_bytes());
        let expected_client = client_data("webauthn.get", &hash(&approval).to_bytes());
        require!(
            args.client_data_json == expected_client,
            AccountError::InvalidClientData
        );
        let auth = &args.assertion_authenticator_data;
        require!(
            auth[..32] == hash(RP_ID.as_bytes()).to_bytes(),
            AccountError::InvalidRpId
        );
        // This narrow first policy permits no extensions or backup metadata.
        require!(auth[32] == 0x05, AccountError::InvalidFlags);
        let mut message = auth.to_vec();
        message.extend_from_slice(&hash(&args.client_data_json).to_bytes());
        verify_precompile(&ctx.accounts.instructions.to_account_info(), &key, &message)?;

        let user = &mut ctx.accounts.user;
        user.version = 1;
        user.user_id = args.user_id;
        user.wallet_count = 1;
        user.passkey_count = 1;
        user.authority_revision = 0;
        user.wallet_link_revision = 0;
        // Sequence zero is permanently consumed by this non-closeable bootstrap.
        user.next_sequence = 1;
        user.profile_reference = [0; 32];
        user.bump = ctx.bumps.user;
        let link = &mut ctx.accounts.wallet_link;
        link.user = user.key();
        link.wallet = ctx.accounts.wallet.key();
        link.active = true;
        link.bump = ctx.bumps.wallet_link;
        let passkey = &mut ctx.accounts.passkey;
        passkey.user = user.key();
        passkey.credential_hash = credential;
        passkey.public_key = key;
        passkey.active = true;
        passkey.bump = ctx.bumps.passkey;
        emit!(UserCreated {
            user: user.key(),
            wallet: link.wallet,
            credential_hash: credential,
            payer: ctx.accounts.payer.key()
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateUserArgs {
    pub user_id: [u8; 32],
    pub expires_at: i64,
    pub credential_hash: [u8; 32],
    // Fixed registration policy: attestation none, 32-byte credential ID,
    // zero AAGUID, canonical ES256 COSE key, no extensions, UV required.
    pub registration_authenticator_data: [u8; REGISTRATION_SIZE],
    pub assertion_authenticator_data: [u8; 37],
    pub client_data_json: Vec<u8>,
}

#[derive(Accounts)]
#[instruction(args: CreateUserArgs)]
pub struct CreateUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub wallet: Signer<'info>,
    #[account(init, payer = payer, space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user", args.user_id.as_ref()], bump)]
    pub user: Account<'info, UserAccount>,
    #[account(init, payer = payer, space = 8 + WalletLink::INIT_SPACE,
        seeds = [b"wallet", user.key().as_ref(), wallet.key().as_ref()], bump)]
    pub wallet_link: Account<'info, WalletLink>,
    #[account(init, payer = payer, space = 8 + PasskeyLink::INIT_SPACE,
        seeds = [b"passkey", user.key().as_ref(), args.credential_hash.as_ref()], bump)]
    pub passkey: Account<'info, PasskeyLink>,
    /// CHECK: canonical instructions sysvar, read with checked Solana helpers.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub version: u8,
    pub user_id: [u8; 32],
    pub wallet_count: u16,
    pub passkey_count: u16,
    pub authority_revision: u64,
    pub wallet_link_revision: u64,
    pub next_sequence: u64,
    pub profile_reference: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WalletLink {
    pub user: Pubkey,
    pub wallet: Pubkey,
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PasskeyLink {
    pub user: Pubkey,
    pub credential_hash: [u8; 32],
    pub public_key: [u8; 33],
    pub active: bool,
    pub bump: u8,
}

#[event]
pub struct UserCreated {
    pub user: Pubkey,
    pub wallet: Pubkey,
    pub credential_hash: [u8; 32],
    pub payer: Pubkey,
}

pub fn credential_hash(registration: &[u8; REGISTRATION_SIZE]) -> [u8; 32] {
    hash(&registration[55..87]).to_bytes()
}

fn validate_registration(reg: &[u8; REGISTRATION_SIZE]) -> Result<[u8; 33]> {
    require!(
        reg[..32] == hash(RP_ID.as_bytes()).to_bytes(),
        AccountError::InvalidRpId
    );
    require!(reg[32] == 0x45, AccountError::InvalidFlags);
    require!(
        reg[33..53] == [0; 20] && reg[53..55] == [0, 32],
        AccountError::InvalidRegistration
    );
    // Canonical CBOR {1:2, 3:-7, -1:1, -2:bytes32(x), -3:bytes32(y)}.
    require!(
        reg[87..97] == [0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]
            && reg[129..132] == [0x22, 0x58, 0x20],
        AccountError::InvalidRegistration
    );
    let mut uncompressed = [0u8; 65];
    uncompressed[0] = 4;
    uncompressed[1..33].copy_from_slice(&reg[97..129]);
    uncompressed[33..].copy_from_slice(&reg[132..164]);
    let public_key = p256::PublicKey::from_sec1_bytes(&uncompressed)
        .map_err(|_| error!(AccountError::InvalidRegistration))?;
    let encoded = public_key.to_encoded_point(true);
    let mut key = [0; 33];
    key.copy_from_slice(encoded.as_bytes());
    Ok(key)
}

// Exact binary encoding is shared with scripts/user-account/client.mjs.
// No JSON/display string is used as the approval payload.
pub fn creation_payload(
    user: Pubkey,
    wallet: Pubkey,
    payer: Pubkey,
    user_id: &[u8; 32],
    key: &[u8; 33],
    credential: &[u8; 32],
    expires_at: i64,
) -> Vec<u8> {
    let mut payload = b"comfi:user-account:create:v1\0".to_vec();
    payload.extend_from_slice(ID.as_ref());
    payload.extend_from_slice(&hash(CLUSTER_DOMAIN).to_bytes());
    payload.extend_from_slice(user.as_ref());
    payload.extend_from_slice(wallet.as_ref());
    payload.extend_from_slice(payer.as_ref());
    payload.extend_from_slice(user_id);
    payload.extend_from_slice(key);
    payload.extend_from_slice(credential);
    payload.extend_from_slice(&hash(RP_ID.as_bytes()).to_bytes());
    payload.extend_from_slice(&hash(ORIGIN.as_bytes()).to_bytes());
    payload.extend_from_slice(&1u16.to_le_bytes()); // enrollment policy version
    payload.extend_from_slice(&0u64.to_le_bytes()); // authority revision
    payload.extend_from_slice(&0u64.to_le_bytes()); // bootstrap sequence
    payload.extend_from_slice(&expires_at.to_le_bytes());
    payload
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        encoded.push(ALPHABET[a >> 2] as char);
        encoded.push(ALPHABET[((a & 3) << 4) | (b >> 4)] as char);
        if chunk.len() > 1 {
            encoded.push(ALPHABET[((b & 15) << 2) | (c >> 6)] as char);
        }
        if chunk.len() > 2 {
            encoded.push(ALPHABET[c & 63] as char);
        }
    }
    encoded
}

pub fn client_data(kind: &str, challenge: &[u8; 32]) -> Vec<u8> {
    format!(
        "{{\"type\":\"{}\",\"challenge\":\"{}\",\"origin\":\"{}\",\"crossOrigin\":false}}",
        kind,
        base64url(challenge),
        ORIGIN
    )
    .into_bytes()
}

fn verify_precompile(instructions: &AccountInfo, key: &[u8; 33], message: &[u8]) -> Result<()> {
    let index = load_current_index_checked(instructions)?;
    require!(index > 0, AccountError::MissingPasskeyProof);
    let ix = load_instruction_at_checked((index - 1) as usize, instructions)?;
    // Restrict to exactly one self-contained native P-256 verification. Reject
    // cross-instruction offsets; a verified unrelated message grants no authority.
    require!(
        ix.program_id == R1_PROGRAM && ix.accounts.is_empty(),
        AccountError::MissingPasskeyProof
    );
    let data = &ix.data;
    require!(
        data.len() == 16 + 64 + 33 + message.len(),
        AccountError::InvalidPasskeyProof
    );
    let expected: [u16; 7] = [
        16,
        u16::MAX,
        80,
        u16::MAX,
        113,
        message.len() as u16,
        u16::MAX,
    ];
    require!(data[..2] == [1, 0], AccountError::InvalidPasskeyProof);
    for (i, value) in expected.iter().enumerate() {
        require!(
            data[2 + i * 2..4 + i * 2] == value.to_le_bytes(),
            AccountError::InvalidPasskeyProof
        );
    }
    require!(
        data[80..113] == key[..] && data[113..] == message[..],
        AccountError::InvalidPasskeyProof
    );
    // The runtime verifies the signature before this instruction executes.
    Ok(())
}

#[error_code]
pub enum AccountError {
    #[msg("UserAccount bootstrap is enabled only in the localnet testing build.")]
    LocalnetOnly,
    #[msg("Approval must expire in the next 300 seconds.")]
    InvalidExpiry,
    #[msg("Unexpected WebAuthn RP ID hash.")]
    InvalidRpId,
    #[msg("Unsupported WebAuthn flags; user presence and verification are required.")]
    InvalidFlags,
    #[msg("Malformed or unsupported ES256 registration.")]
    InvalidRegistration,
    #[msg(
        "Client data does not match the exact action, challenge, origin and cross-origin policy."
    )]
    InvalidClientData,
    #[msg("An immediately preceding native P-256 passkey proof is required.")]
    MissingPasskeyProof,
    #[msg("Passkey proof does not match this credential and assertion.")]
    InvalidPasskeyProof,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_client_data_uses_unpadded_challenge() {
        assert_eq!(
            base64url(&[255; 32]),
            "__________________________________________8"
        );
        assert!(String::from_utf8(client_data("webauthn.get", &[0; 32]))
            .unwrap()
            .ends_with("\"crossOrigin\":false}"));
    }
    #[test]
    fn canonical_payload_matches_javascript_vector() {
        let (user, _) = Pubkey::find_program_address(&[b"user", &[5; 32]], &ID);
        let payload = creation_payload(
            user,
            Pubkey::new_from_array([3; 32]),
            Pubkey::new_from_array([4; 32]),
            &[5; 32],
            &[6; 33],
            &hash(&[7; 32]).to_bytes(),
            1800000000,
        );
        assert_eq!(
            hash(&payload).to_bytes(),
            [
                0x8f, 0xab, 0x4f, 0xcf, 0x9f, 0xf8, 0x2d, 0xa0, 0x83, 0x1b, 0x6b, 0x25, 0x02, 0x08,
                0xb8, 0x7f, 0x73, 0xe0, 0xce, 0x45, 0x01, 0x9c, 0x8d, 0x35, 0x44, 0x7f, 0x83, 0x09,
                0x15, 0x55, 0xd5, 0x8b
            ]
        );
    }
    #[test]
    fn malformed_registration_is_rejected() {
        assert!(validate_registration(&[0; REGISTRATION_SIZE]).is_err());
    }
    #[test]
    fn payload_binds_payer_wallet_expiry_and_account() {
        let user = Pubkey::new_unique();
        let wallet = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let original = creation_payload(user, wallet, payer, &[1; 32], &[2; 33], &[3; 32], 10);
        assert_ne!(
            original,
            creation_payload(
                user,
                wallet,
                Pubkey::new_unique(),
                &[1; 32],
                &[2; 33],
                &[3; 32],
                10
            )
        );
        assert_ne!(
            original,
            creation_payload(
                user,
                Pubkey::new_unique(),
                payer,
                &[1; 32],
                &[2; 33],
                &[3; 32],
                10
            )
        );
        assert_ne!(
            original,
            creation_payload(
                Pubkey::new_unique(),
                wallet,
                payer,
                &[1; 32],
                &[2; 33],
                &[3; 32],
                10
            )
        );
        assert_ne!(
            original,
            creation_payload(user, wallet, payer, &[1; 32], &[2; 33], &[3; 32], 11)
        );
    }
}
