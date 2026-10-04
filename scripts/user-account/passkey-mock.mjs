// Disposable localnet authenticator. Real ES256 signatures; never a verification bypass.
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const RP_ID = 'localhost';
export const ORIGIN = 'http://localhost:5173';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export function clientData(type, challenge) {
  if (!['webauthn.create', 'webauthn.get'].includes(type)) throw new Error('Unsupported WebAuthn type');
  if (!Buffer.isBuffer(challenge) || challenge.length !== 32) throw new Error('Challenge must be 32 bytes');
  return Buffer.from(JSON.stringify({ type, challenge: challenge.toString('base64url'), origin: ORIGIN, crossOrigin: false }));
}

export function createPasskeyMock() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const compressedKey = Buffer.concat([Buffer.from([2 | (y[31] & 1)]), x]);
  const credentialId = randomBytes(32);
  const cose = Buffer.concat([Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const registrationAuthenticatorData = Buffer.concat([sha256(Buffer.from(RP_ID)), Buffer.from([0x45]), Buffer.alloc(4 + 16), Buffer.from([0, 32]), credentialId, cose]);
  return {
    publicKey: compressedKey,
    credentialId,
    registrationAuthenticatorData,
    assert(challenge) {
      const clientDataJson = clientData('webauthn.get', challenge);
      const authenticatorData = Buffer.concat([sha256(Buffer.from(RP_ID)), Buffer.from([0x05]), Buffer.alloc(4)]);
      const message = Buffer.concat([authenticatorData, sha256(clientDataJson)]);
      const signature = sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      // Solana's r1 verifier requires a low-S IEEE P1363 signature.
      const s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
      if (s > P256_ORDER / 2n) Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex').copy(signature, 32);
      return { authenticatorData, clientDataJson, message, signature };
    },
    verify(message, signature) {
      return verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    },
  };
}
