import { ReceiptError } from "../errors.js";
import { deriveKeyId, type ReceiptSigner } from "./signer.js";

export type SignerKeySource =
  | { generate: true }
  | { privateKey: CryptoKey; publicKey: CryptoKey }
  | { pkcs8: Uint8Array<ArrayBuffer>; publicKeyRaw?: Uint8Array<ArrayBuffer> }
  | { jwk: JsonWebKey };

interface AlgorithmProfile {
  id: "ed25519" | "ecdsa-p256-sha256";
  generateParams: AlgorithmIdentifier | EcKeyGenParams;
  importParams: AlgorithmIdentifier | EcKeyImportParams;
  signParams: AlgorithmIdentifier | EcdsaParams;
}

const ED25519: AlgorithmProfile = {
  id: "ed25519",
  generateParams: "Ed25519",
  importParams: "Ed25519",
  signParams: "Ed25519",
};

const P256: AlgorithmProfile = {
  id: "ecdsa-p256-sha256",
  generateParams: { name: "ECDSA", namedCurve: "P-256" },
  importParams: { name: "ECDSA", namedCurve: "P-256" },
  signParams: { name: "ECDSA", hash: "SHA-256" },
};

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (api === undefined) {
    throw new ReceiptError({
      code: "UNSUPPORTED",
      message: "Web Crypto (crypto.subtle) is not available in this runtime.",
      operation: "sign",
    });
  }
  return api;
}

async function resolveKeys(
  profile: AlgorithmProfile,
  source: SignerKeySource,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const api = subtle();
  try {
    if ("generate" in source) {
      const pair = (await api.generateKey(profile.generateParams, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      return { privateKey: pair.privateKey, publicKey: pair.publicKey };
    }
    if ("privateKey" in source) {
      return { privateKey: source.privateKey, publicKey: source.publicKey };
    }
    if ("pkcs8" in source) {
      const privateKey = await api.importKey(
        "pkcs8",
        source.pkcs8,
        profile.importParams,
        false,
        ["sign"],
      );
      if (source.publicKeyRaw === undefined) {
        throw new ReceiptError({
          code: "KEY_IMPORT_FAILED",
          message:
            "pkcs8 import needs publicKeyRaw — Web Crypto cannot derive the public half",
          operation: "importKey",
        });
      }
      const publicKey = await api.importKey(
        "raw",
        source.publicKeyRaw,
        profile.importParams,
        true,
        ["verify"],
      );
      return { privateKey, publicKey };
    }
    const privateJwk = source.jwk;
    const privateKey = await api.importKey(
      "jwk",
      privateJwk,
      profile.importParams,
      false,
      ["sign"],
    );
    const publicJwk: JsonWebKey = { ...privateJwk };
    delete (publicJwk as Record<string, unknown>).d;
    publicJwk.key_ops = ["verify"];
    const publicKey = await api.importKey(
      "jwk",
      publicJwk,
      profile.importParams,
      true,
      ["verify"],
    );
    return { privateKey, publicKey };
  } catch (error) {
    if (error instanceof ReceiptError) {
      throw error;
    }
    throw new ReceiptError({
      code: "KEY_IMPORT_FAILED",
      message: `could not import ${profile.id} key material`,
      operation: "importKey",
      cause: error,
    });
  }
}

async function publicKeyBytes(
  profile: AlgorithmProfile,
  publicKey: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  // Ed25519: 32 raw bytes. P-256: 65-byte uncompressed point.
  return new Uint8Array(await subtle().exportKey("raw", publicKey));
}

async function buildSigner(
  profile: AlgorithmProfile,
  source: SignerKeySource,
): Promise<ReceiptSigner & { publicKeyJwk: JsonWebKey }> {
  const { privateKey, publicKey } = await resolveKeys(profile, source);
  const raw = await publicKeyBytes(profile, publicKey);
  const keyId = await deriveKeyId(raw);
  const publicKeyJwk = (await subtle().exportKey("jwk", publicKey)) as JsonWebKey;
  delete (publicKeyJwk as Record<string, unknown>).key_ops;
  delete (publicKeyJwk as Record<string, unknown>).ext;
  return {
    algorithm: profile.id,
    keyId,
    publicKeyJwk,
    async sign(payload) {
      try {
        return new Uint8Array(
          await subtle().sign(profile.signParams, privateKey, payload),
        );
      } catch (error) {
        throw new ReceiptError({
          code: "SIGNING_FAILED",
          message: `${profile.id} signing failed in this runtime`,
          operation: "sign",
          cause: error,
        });
      }
    },
  };
}

export function createEd25519Signer(
  source: SignerKeySource,
): Promise<ReceiptSigner & { publicKeyJwk: JsonWebKey }> {
  return buildSigner(ED25519, source);
}

export function createEcdsaP256Signer(
  source: SignerKeySource,
): Promise<ReceiptSigner & { publicKeyJwk: JsonWebKey }> {
  return buildSigner(P256, source);
}

export interface VerificationKey {
  algorithm: "ed25519" | "ecdsa-p256-sha256";
  keyId: string;
  verify(
    payload: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>;
}

/** Imports a public JWK for verification and derives its key id. */
export async function importVerificationKey(
  jwk: JsonWebKey,
): Promise<VerificationKey> {
  const profile =
    jwk.kty === "OKP" && jwk.crv === "Ed25519"
      ? ED25519
      : jwk.kty === "EC" && jwk.crv === "P-256"
        ? P256
        : undefined;
  if (profile === undefined) {
    throw new ReceiptError({
      code: "KEY_IMPORT_FAILED",
      message: "only Ed25519 (OKP) and P-256 (EC) public JWKs are supported",
      operation: "importKey",
    });
  }
  const api = subtle();
  const cleaned: JsonWebKey = { ...jwk };
  delete (cleaned as Record<string, unknown>).d;
  let publicKey: CryptoKey;
  try {
    publicKey = await api.importKey("jwk", cleaned, profile.importParams, true, [
      "verify",
    ]);
  } catch (error) {
    throw new ReceiptError({
      code: "KEY_IMPORT_FAILED",
      message: `could not import ${profile.id} public key`,
      operation: "importKey",
      cause: error,
    });
  }
  const raw = await publicKeyBytes(profile, publicKey);
  return {
    algorithm: profile.id,
    keyId: await deriveKeyId(raw),
    async verify(payload, signature) {
      try {
        return await api.verify(profile.signParams, publicKey, signature, payload);
      } catch {
        return false;
      }
    },
  };
}

/** The verification half of a signer, as a portable JWK. */
export function exportVerificationKey(
  signer: ReceiptSigner & { publicKeyJwk?: JsonWebKey },
): JsonWebKey {
  if (signer.publicKeyJwk === undefined) {
    throw new ReceiptError({
      code: "INVALID_ARGUMENT",
      message: "this signer does not expose a public JWK",
      operation: "sign",
    });
  }
  return signer.publicKeyJwk;
}
