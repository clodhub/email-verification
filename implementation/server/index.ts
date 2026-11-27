// The entry module of email-verification's server code: everything code outside the component may use.
export {
  DEFAULT_SETTINGS, EMAIL_CODES_COLLECTION, MAXIMUM_FAILURES, MINIMUM_SECRET_LENGTH, createEmailVerification, installedSettings, normaliseEmail, settingsFrom,
  verificationPath,
} from "./verification.ts";
export type {
  CodeDocument, ConfirmResult, EmailVerification, EmailVerificationDeps, EmailVerificationSettings, RecordsLike, ShortCodes, StartResult,
} from "./verification.ts";
